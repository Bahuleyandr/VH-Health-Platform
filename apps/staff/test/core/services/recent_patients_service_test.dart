import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/services/recent_patients_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    RecentPatientsService.debugStaffIdentityOverride = null;
  });

  tearDown(() async {
    RecentPatientsService.debugStaffIdentityOverride = null;
  });

  group('RecentPatientsService', () {
    test(
      'keeps recent patients scoped to the signed-in staff member',
      () async {
        RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
        await RecentPatientsService.add('patient-a', 'Alice');

        expect(
          await RecentPatientsService.getAll(),
          contains(
            predicate<Map<String, dynamic>>(
              (entry) =>
                  entry['uid'] == 'patient-a' && entry['name'] == 'Alice',
            ),
          ),
        );

        RecentPatientsService.debugStaffIdentityOverride = 'staff-b';
        await RecentPatientsService.add('patient-b', 'Bob');

        final staffBRecents = await RecentPatientsService.getAll();
        expect(staffBRecents.map((entry) => entry['uid']), ['patient-b']);

        RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
        final staffARecents = await RecentPatientsService.getAll();
        expect(staffARecents.map((entry) => entry['uid']), ['patient-a']);
      },
    );

    test('does not expose recents when no staff identity is stored', () async {
      await RecentPatientsService.add('patient-a', 'Alice');
      expect(await RecentPatientsService.getAll(), isEmpty);
    });

    test(
      'stores entries in secure storage, never plaintext SharedPreferences (M10)',
      () async {
        RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
        await RecentPatientsService.add('patient-a', 'Alice');

        // The cache is readable through the service…
        final recents = await RecentPatientsService.getAll();
        expect(recents.map((entry) => entry['uid']), ['patient-a']);

        // …but NOTHING about it lands in plaintext SharedPreferences.
        final prefs = await SharedPreferences.getInstance();
        final phiKeys = prefs
            .getKeys()
            .where((k) => k.startsWith('recent_patients'))
            .toList();
        expect(phiKeys, isEmpty);
      },
    );

    test(
      'migrating wipes pre-existing plaintext recents on first write (M10)',
      () async {
        // Simulate an upgraded install that still has the old plaintext cache.
        SharedPreferences.setMockInitialValues({
          'recent_patients:staff:staff-a': jsonEncode([
            {'uid': 'old-plaintext-patient', 'name': 'Old'},
          ]),
          'recent_patients_keys': ['recent_patients:staff:staff-a'],
        });

        RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
        await RecentPatientsService.add('patient-a', 'Alice');

        final prefs = await SharedPreferences.getInstance();
        expect(
          prefs.getKeys().where((k) => k.startsWith('recent_patients')),
          isEmpty,
        );
      },
    );

    test('logout cleanup removes scoped and legacy recent caches', () async {
      RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
      await RecentPatientsService.add('patient-a', 'Alice');

      RecentPatientsService.debugStaffIdentityOverride = 'staff-b';
      await RecentPatientsService.add('patient-b', 'Bob');

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        'recent_patients',
        jsonEncode([
          {'uid': 'legacy-patient', 'name': 'Legacy'},
        ]),
      );

      RecentPatientsService.debugStaffIdentityOverride = null;
      await RecentPatientsService.clear();

      expect(prefs.getString('recent_patients'), isNull);
      expect(prefs.getStringList('recent_patients_keys'), isNull);

      RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
      expect(await RecentPatientsService.getAll(), isEmpty);

      RecentPatientsService.debugStaffIdentityOverride = 'staff-b';
      expect(await RecentPatientsService.getAll(), isEmpty);
    });
  });
}
