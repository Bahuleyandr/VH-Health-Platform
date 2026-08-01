import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/outage/patient_outage_config.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final store = PatientOutageConfigStore.instance;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await store.resetForTesting();
  });

  tearDown(() async {
    await store.resetForTesting();
  });

  test(
    'persists only a validated higher-revision five-language snapshot',
    () async {
      expect(await store.accept(_communication(2)), isTrue);
      expect(store.current?.revision, 2);
      expect(await store.accept(_communication(2)), isFalse);
      expect(await store.accept(_communication(1)), isFalse);
      expect(
        await store.accept({..._communication(3), 'policy': true}),
        isFalse,
      );

      store.resetMemoryForTesting();
      await store.load();

      expect(store.current?.revision, 2);
      expect(store.current?.messages.keys.toSet(), {
        'en',
        'hi',
        'ta',
        'te',
        'ml',
      });
      expect(store.current?.facilityContactNumber, '+91 44 4511 4511');
    },
  );

  test('rejects malformed locale, contact, and message records', () async {
    final missingLocale = _communication(1);
    (missingLocale['messages'] as Map<String, String>).remove('ml');
    final missingToken = _communication(1);
    (missingToken['messages'] as Map<String, String>)['en'] =
        'No contact token';

    expect(await store.accept(missingLocale), isFalse);
    expect(await store.accept(missingToken), isFalse);
    expect(
      await store.accept({
        ..._communication(1),
        'facility_contact_number': 'javascript:alert(1)',
      }),
      isFalse,
    );
    final oversized = _communication(1);
    (oversized['messages'] as Map<String, String>)['en'] =
        '${'x' * 17000} [facility contact number]';
    expect(await store.accept(oversized), isFalse);
    expect(store.current, isNull);
  });

  test('ignores a snapshot copied from another API source', () async {
    expect(await store.accept(_communication(4)), isTrue);
    final preferences = await SharedPreferences.getInstance();
    final key = preferences.getKeys().single;
    final envelope =
        jsonDecode(preferences.getString(key)!) as Map<String, dynamic>;
    envelope['source'] = 'https://other.invalid/api/v1';
    await preferences.setString(key, jsonEncode(envelope));

    store.resetMemoryForTesting();
    await store.load();

    expect(store.current, isNull);
  });
}

Map<String, dynamic> _communication(int revision) => {
  'revision': revision,
  'messages': {
    for (final locale in ['en', 'hi', 'ta', 'te', 'ml'])
      locale: '$locale approved [facility contact number]',
  },
  'facility_contact_number': '+91 44 4511 4511',
};
