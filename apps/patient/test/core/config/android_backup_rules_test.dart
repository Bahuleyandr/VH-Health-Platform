// Guard for the patient app's Android backup / device-transfer suppression.
//
// Re-audit lane L: the manifest declared only android:allowBackup="false".
// That suppresses cloud Auto Backup on every API level but does NOT suppress
// Android 12+ device-to-device transfer, so a patient's PHI (offline API
// cache + the flutter_secure_storage blob) rode along to a new handset.
//
// The class this guard closes is "part of the suppression silently goes
// missing again" — the attribute that covers D2D, the pre-Android-12
// attribute standing behind it, or one of the domain exclusions the rules
// file needs in order to mean "the whole sandbox".
//
// [_domains] is the platform's COMPLETE domain set, not the subset this app
// happens to use: AOSP's FullBackup.BackupScheme.getTokenForXmlDomain maps
// exactly these nine strings to a backup tree token, and Android Lint's
// FullBackupContentDetector validates against the same nine. An unrecognised
// domain is skipped at run time with only a verbose log, so a typo reads as
// "excluded" while the data it names is still copied — which is why 'no
// exclusion names an unknown domain' below asserts the reverse direction too.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _domains = <String>[
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];

void main() {
  // Comments are stripped from BOTH files first: each one's prose explains
  // the very attributes asserted below, and a guard that a comment can
  // satisfy is not a guard.
  final manifest = File('android/app/src/main/AndroidManifest.xml')
      .readAsStringSync()
      .replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');
  final rules = File('android/app/src/main/res/xml/data_extraction_rules.xml')
      .readAsStringSync()
      .replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

  // All three attributes below sit on the <application> element, so assert
  // them against that element rather than against the file: an attribute
  // parked on an <activity> satisfies a file-wide `contains` while leaving
  // the application tag bare. No attribute value here contains '>', so the
  // opening tag runs from '<application' to the first '>'.
  final applicationTags = RegExp(
    r'<application\b[^>]*>',
  ).allMatches(manifest).map((match) => match.group(0)!).toList();
  final applicationTag = applicationTags.length == 1
      ? applicationTags.single
      : '';

  group('patient Android backup + device-transfer suppression', () {
    test('the parser actually sees the application tag (self-check)', () {
      // Without this, a regex that stopped matching would leave every
      // assertion below testing the empty string — loudly, but for the wrong
      // reason.
      expect(applicationTags, hasLength(1));
      expect(applicationTag, contains('android:name='));
    });

    test('the application tag declares all three era-specific attributes', () {
      // API 26+ — cloud Auto Backup and `adb backup`.
      expect(applicationTag, contains('android:allowBackup="false"'));
      // API 26-30 — the pre-Android-12 full-data backup set.
      expect(applicationTag, contains('android:fullBackupContent="false"'));
      // API 31+ — the only attribute that can suppress device transfer.
      expect(
        applicationTag,
        contains('android:dataExtractionRules="@xml/data_extraction_rules"'),
      );
    });

    test('dataExtractionRules is usable at the application tools:targetApi', () {
      // <data-extraction-rules> is API 31. The application tag must claim at
      // least 31 or the manifest merger/lint flags the attribute — so read
      // tools:targetApi off that tag, not off whichever element in the file
      // happens to carry one.
      final match = RegExp(
        r'tools:targetApi="(\d+)"',
      ).firstMatch(applicationTag);
      expect(match, isNotNull, reason: 'application tag lost tools:targetApi');
      expect(int.parse(match!.group(1)!), greaterThanOrEqualTo(31));
    });

    test('both extraction channels are declared', () {
      // allowBackup covers <cloud-backup> already; <device-transfer> is the
      // channel that had no coverage at all before lane L.
      expect(rules, contains('<cloud-backup>'));
      expect(rules, contains('<device-transfer>'));
    });

    test('every backup domain is excluded in both channels', () {
      final cloud = _channel(rules, 'cloud-backup');
      final transfer = _channel(rules, 'device-transfer');
      for (final domain in _domains) {
        final exclusion = '<exclude domain="$domain" path="." />';
        expect(
          cloud,
          contains(exclusion),
          reason: 'cloud-backup does not exclude the "$domain" domain',
        );
        expect(
          transfer,
          contains(exclusion),
          reason: 'device-transfer does not exclude the "$domain" domain',
        );
      }
    });

    test('no exclusion names a domain the platform does not know', () {
      // The platform drops an unrecognised domain with a verbose log and
      // carries on, so a typo reads as "excluded" and backs the data up.
      final declared = RegExp(
        r'domain="([^"]*)"',
      ).allMatches(rules).map((match) => match.group(1)!).toSet();
      expect(declared, isNotEmpty);
      expect(
        declared.difference(_domains.toSet()).toList()..sort(),
        isEmpty,
        reason:
            'Not a real backup domain — the platform silently ignores it, so '
            'the data it names would still be copied.',
      );
    });

    test('no <include> re-admits any path', () {
      // A single <include> flips the file from "exclude everything" to
      // "back up exactly this", which would silently restore the leak.
      expect(rules, isNot(contains('<include')));
    });
  });
}

String _channel(String rules, String tag) {
  final start = rules.indexOf('<$tag>');
  final end = rules.indexOf('</$tag>');
  expect(start, isNonNegative, reason: 'missing <$tag>');
  expect(end, greaterThan(start), reason: 'missing </$tag>');
  return rules.substring(start, end);
}
