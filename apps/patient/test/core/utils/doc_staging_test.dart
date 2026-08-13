import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/utils/doc_staging.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tempDir;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('doc_staging_test_');
    _installPathProviderFake(tempDir.path);
  });

  tearDown(() async {
    if (await tempDir.exists()) await tempDir.delete(recursive: true);
  });

  test(
    'cold-start purge removes staged plaintext but preserves unrelated temp data',
    () async {
      final staged = await DocStaging.writePlaintext('report.pdf', <int>[
        1,
        2,
        3,
      ]);
      final unrelated = File(
        '${tempDir.path}${Platform.pathSeparator}plugin.tmp',
      );
      await unrelated.writeAsString('plugin state');

      await DocStaging.purge();

      expect(await staged.exists(), isFalse);
      expect(await unrelated.exists(), isTrue);
    },
  );

  test(
    'failure cleanup only deletes files inside the staging directory',
    () async {
      final staged = await DocStaging.writePlaintext('report.pdf', <int>[1]);
      final unrelated = File(
        '${tempDir.path}${Platform.pathSeparator}outside.pdf',
      );
      await unrelated.writeAsBytes(<int>[2]);

      await DocStaging.delete(staged);
      await DocStaging.delete(unrelated);

      expect(await staged.exists(), isFalse);
      expect(await unrelated.exists(), isTrue);
    },
  );
}

void _installPathProviderFake(String temporaryPath) {
  const channel = MethodChannel('plugins.flutter.io/path_provider');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        if (call.method == 'getTemporaryDirectory') return temporaryPath;
        return null;
      });
}
