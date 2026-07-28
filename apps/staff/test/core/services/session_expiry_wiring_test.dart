import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'HTTP and realtime expiry use the forced-preservation coordinator',
    () async {
      final source = await File('lib/main.dart').readAsString();

      expect(source, contains('ApiClient.onSessionExpired'));
      expect(source, contains('onSessionExpired: _handleServerSessionExpired'));
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
}
