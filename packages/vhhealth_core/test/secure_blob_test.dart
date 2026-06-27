import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/secure_blob.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final Map<String, String> store = {};
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
    final args = Map<String, dynamic>.from(call.arguments as Map);
    switch (call.method) {
      case 'read':
        return store[args['key']];
      case 'write':
        store[args['key']] = args['value'] as String;
        return null;
      case 'delete':
        store.remove(args['key']);
        return null;
      default:
        return null;
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(_installSecureStorageFake);

  test('seal → open round-trips and produces iv:ciphertext', () async {
    final codec = SecureBlobCodec('mar_cache_aes_key_test');
    final enc = await codec.seal('{"hello":"world"}');
    expect(enc.split(':').length, 2);
    expect(enc, isNot(contains('hello'))); // not plaintext
    expect(await codec.open(enc), '{"hello":"world"}');
  });

  test('a tampered ciphertext fails to open (GCM auth)', () async {
    final codec = SecureBlobCodec('mar_cache_aes_key_test');
    final enc = await codec.seal('secret');
    final parts = enc.split(':');
    final tampered = '${parts[0]}:${parts[1].substring(0, parts[1].length - 2)}AA';
    expect(() => codec.open(tampered), throwsA(anything));
  });
}
