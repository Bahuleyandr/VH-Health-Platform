import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'HTTP and realtime expiry use the forced-preservation coordinator',
    () async {
      final source = await File('lib/main.dart').readAsString();

      expect(source, contains('ApiClient.onSessionExpired'));
      expect(source, contains('onSessionExpired: _handleServerSessionExpired'));
      expect(
        source,
        contains('timeout?.lockSession()'),
        reason: 'The previous clinical surface must lock before async cleanup.',
      );
      expect(source, contains('ForcedLogoutFlow.run('));
      expect(
        source,
        contains('scaffoldMessengerKey: _staffScaffoldMessengerKey'),
      );
      expect(source, contains('sessionRevocationPreservedItems(count)'));
    },
  );

  test(
    'staff production and integration sources never bulk-delete secure storage',
    () async {
      final files = <File>[];
      for (final path in ['lib', 'integration_test']) {
        await for (final entry in Directory(path).list(recursive: true)) {
          if (entry is File && entry.path.endsWith('.dart')) {
            files.add(entry);
          }
        }
      }

      final offenders = <String>[];
      for (final file in files) {
        final source = await file.readAsString();
        if (source.contains('.deleteAll()')) {
          offenders.add(file.path);
        }
      }

      expect(
        offenders,
        isEmpty,
        reason:
            'Bulk secure-storage deletion can erase the offline queue AES key.',
      );
    },
  );

  test(
    'timeout and realtime revocation lock before their first async cleanup',
    () async {
      final timeoutSource = await File(
        'lib/core/providers/session_timeout_provider.dart',
      ).readAsString();
      final timeoutHandler = timeoutSource.substring(
        timeoutSource.indexOf('Future<void> _onTimeout() async'),
        timeoutSource.indexOf('void _scheduleIdleTimers()'),
      );
      expect(timeoutHandler, contains('lockSession();'));
      expect(
        timeoutHandler.indexOf('lockSession();'),
        lessThan(timeoutHandler.indexOf('await _beforeTimeoutCleanup?.call()')),
      );
      expect(
        timeoutHandler.indexOf('await _beforeTimeoutCleanup?.call()'),
        lessThan(timeoutHandler.indexOf('await _pendingOfflineWriteCount()')),
      );

      final revocationSource = await File(
        'lib/core/widgets/session_revocation_listener.dart',
      ).readAsString();
      final revocationHandler = revocationSource.substring(
        revocationSource.indexOf('Future<void> _onRevoked'),
        revocationSource.indexOf('void dispose()'),
      );
      expect(
        revocationHandler.indexOf('timeout.lockSession();'),
        lessThan(revocationHandler.indexOf('await ForcedLogoutFlow.run(')),
      );

      final layerSource = await File(
        'lib/core/widgets/session_timeout_warning_layer.dart',
      ).readAsString();
      expect(
        layerSource,
        contains(
          'if (timeout.isSessionLocked) const StaffSessionLockSurface()',
        ),
      );
      expect(layerSource, contains('excluding: timeout.isSessionLocked'));
      expect(layerSource, contains('ignoring: timeout.isSessionLocked'));
    },
  );
}
