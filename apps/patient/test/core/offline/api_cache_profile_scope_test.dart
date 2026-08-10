// test/core/offline/api_cache_profile_scope_test.dart
//
// PAT-5 (2026-08-10 re-review): ApiCacheManager keys are namespaced by the
// acting-as profile, but the namespace used to be resolved when save() ran —
// AFTER the network await — so a guardian switching profiles while a fetch
// was in flight re-homed the response under the wrong profile's cache.
// CacheProfileScope captures the namespace at request time; ApiClient.cachedGet
// passes it to every load/save belonging to that request.

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tempDir;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('api_cache_scope_test_');
    _installPathProviderFake(tempDir.path);
    _installSecureStorageFake();
    VHHttpClient.actingAsUidProvider = null;
    await ApiCacheManager.clearAll();
  });

  tearDown(() async {
    VHHttpClient.actingAsUidProvider = null;
    await ApiCacheManager.clearAll();
    if (await tempDir.exists()) {
      await tempDir.delete(recursive: true);
    }
  });

  test('a request-time snapshot pins the save namespace across a mid-flight '
      'profile switch', () async {
    // Request starts while acting as the dependent.
    VHHttpClient.actingAsUidProvider = () => 'dep-uid-1';
    final scope = CacheProfileScope.current();

    // Guardian switches back to their own profile while the fetch is in
    // flight; the response must still be filed under the dependent.
    VHHttpClient.actingAsUidProvider = () => null;
    await ApiCacheManager.save('/portal/lab-results', {
      'who': 'dependent',
    }, profile: scope);

    // Guardian's (active) namespace must NOT serve the dependent's data.
    expect(await ApiCacheManager.load('/portal/lab-results'), isNull);

    // The dependent's namespace has it — via the live resolver...
    VHHttpClient.actingAsUidProvider = () => 'dep-uid-1';
    final cached = await ApiCacheManager.load('/portal/lab-results');
    expect(cached, isNotNull);
    expect((cached!.data as Map)['who'], 'dependent');

    // ...and via the pinned snapshot, independent of the live resolver.
    VHHttpClient.actingAsUidProvider = () => null;
    final pinned = await ApiCacheManager.load(
      '/portal/lab-results',
      profile: scope,
    );
    expect(pinned, isNotNull);
    expect((pinned!.data as Map)['who'], 'dependent');
  });

  test('a guardian-profile snapshot stays un-prefixed even if a dependent '
      'becomes active mid-flight', () async {
    final scope = CacheProfileScope.current(); // guardian: uid == null

    VHHttpClient.actingAsUidProvider = () => 'dep-uid-1';
    await ApiCacheManager.save('/portal/bills', {
      'who': 'guardian',
    }, profile: scope);

    // Dependent namespace must not see the guardian's data.
    expect(await ApiCacheManager.load('/portal/bills'), isNull);

    // Guardian namespace has it.
    VHHttpClient.actingAsUidProvider = () => null;
    final cached = await ApiCacheManager.load('/portal/bills');
    expect(cached, isNotNull);
    expect((cached!.data as Map)['who'], 'guardian');
  });

  test(
    'without a snapshot the namespace resolves at call time (legacy)',
    () async {
      VHHttpClient.actingAsUidProvider = () => 'dep-uid-2';
      await ApiCacheManager.save('/portal/referrals', {'n': 1});
      expect(await ApiCacheManager.load('/portal/referrals'), isNotNull);

      VHHttpClient.actingAsUidProvider = () => null;
      expect(await ApiCacheManager.load('/portal/referrals'), isNull);
    },
  );
}

void _installPathProviderFake(String documentsPath) {
  const channel = MethodChannel('plugins.flutter.io/path_provider');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        if (call.method == 'getApplicationDocumentsDirectory') {
          return documentsPath;
        }
        return null;
      });
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = call.arguments == null
            ? <String, dynamic>{}
            : Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}
