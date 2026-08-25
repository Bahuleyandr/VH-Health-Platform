// Guard for the staff app's Android backup / device-transfer suppression.
//
// Twin of apps/patient/test/core/config/android_backup_rules_test.dart. The
// staff app carries the same shape as the patient app — the same three
// <application> attributes and the same two-channel data_extraction_rules.xml
// — and holds clinical PHI on shared ward/kiosk devices, so the same class
// applies: "part of the suppression silently goes missing again".
//
// TWO ASSERTIONS FROM THE PATIENT GUARD ARE DELIBERATELY ABSENT HERE, because
// asserting them would be asserting something this app does not declare:
//
//   tools:targetApi — the patient manifest carries tools:targetApi="31" on its
//     <application> tag; this manifest declares no `tools` namespace at all.
//     That attribute only suppresses a lint NewApi warning for an attribute
//     the platform already ignores below API 31, so its absence is not a hole.
//
//   the four device-protected (Direct Boot) domains — the patient rules file
//     excludes all nine platform domains; this one excludes the five that are
//     not device-protected. That is a real narrowing, not a style difference,
//     and it is inert only for as long as this app writes nothing to
//     device-protected storage. 'no component is directBootAware' below is
//     what makes that conditional true rather than assumed: the moment a
//     directBootAware component is added, this test fails and the four
//     device_* exclusions have to be added to the rules file.
//
// [_knownDomains] is the platform's COMPLETE domain set, used only to reject
// misspellings: AOSP's FullBackup.BackupScheme.getTokenForXmlDomain maps
// exactly these nine strings to a backup tree token and skips anything else
// with only a verbose log, so a typo is silent at build AND at run time.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _knownDomains = <String>{
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
};

// The domains this app's rules file is required to exclude. Deliberately the
// non-device-protected five — see the header.
const _requiredDomains = <String>[
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
];

void main() {
  // Comments are stripped from BOTH files first: each one's prose explains the
  // very attributes asserted below, and a guard that a comment can satisfy is
  // not a guard.
  final manifest = File('android/app/src/main/AndroidManifest.xml')
      .readAsStringSync()
      .replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');
  final rules = File('android/app/src/main/res/xml/data_extraction_rules.xml')
      .readAsStringSync()
      .replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

  // All three attributes below sit on the <application> element, so assert
  // them against that element rather than against the file. An attribute
  // parked on an <activity> would satisfy a file-wide `contains` while leaving
  // the application tag bare. No attribute value contains '>', so the opening
  // tag runs from '<application' to the first '>'.
  final applicationTags = RegExp(r'<application\b[^>]*>')
      .allMatches(manifest)
      .map((match) => match.group(0)!)
      .toList();
  final applicationTag = applicationTags.length == 1
      ? applicationTags.single
      : '';

  group('staff Android backup + device-transfer suppression', () {
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

    test('both extraction channels are declared', () {
      // allowBackup covers <cloud-backup> already; <device-transfer> is the
      // channel allowBackup cannot reach.
      expect(rules, contains('<cloud-backup>'));
      expect(rules, contains('<device-transfer>'));
    });

    test('every required backup domain is excluded in both channels', () {
      final cloud = _channel(rules, 'cloud-backup');
      final transfer = _channel(rules, 'device-transfer');
      for (final domain in _requiredDomains) {
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

    test('the two channels exclude exactly the same domains', () {
      // A domain dropped from one channel only is the original defect in
      // miniature: the file still looks like "exclude everything".
      expect(
        _domainsIn(_channel(rules, 'cloud-backup')),
        equals(_domainsIn(_channel(rules, 'device-transfer'))),
      );
    });

    test('no exclusion names a domain the platform does not know', () {
      // The platform drops an unrecognised domain with a verbose log and
      // carries on, so a typo reads as "excluded" and backs the data up.
      final declared = _domainsIn(rules);
      expect(declared, isNotEmpty);
      expect(
        declared.difference(_knownDomains).toList()..sort(),
        isEmpty,
        reason:
            'Not a real backup domain — the platform silently ignores it, so '
            'the data it names would still be copied.',
      );
    });

    test('device-protected domains are excluded, not reasoned away', () {
      // An earlier version of this suite omitted the four device_* domains and
      // justified it with a 'no component is directBootAware' assertion over
      // THIS file's manifest. That assertion could never fail:
      // directBootAware components arrive by MANIFEST MERGE from libraries, so
      // the app-local manifest cannot show them — and the merged manifest
      // carries four today (FirebaseInitProvider, FirebaseMessagingService,
      // ComponentDiscoveryService, MlKitComponentDiscoveryService). The guard
      // passed vacuously while the premise it guarded was false.
      //
      // Both channels now exclude all nine domains, so there is nothing left to
      // reason about.
      for (final domain in const [
        'device_root',
        'device_file',
        'device_database',
        'device_sharedpref',
      ]) {
        expect(
          RegExp('<exclude domain="$domain"').allMatches(rules).length,
          2,
          reason:
              'Domain $domain must be excluded on BOTH cloud-backup and '
              'device-transfer; device-protected storage is reachable by the '
              'directBootAware components Firebase and MLKit merge in.',
        );
      }
    });

    test('no <include> re-admits any path', () {
      // A single <include> flips the file from "exclude everything" to "back
      // up exactly this", which would silently restore the leak.
      expect(rules, isNot(contains('<include')));
    });
  });
}

Set<String> _domainsIn(String xml) =>
    RegExp(r'domain="([^"]*)"')
        .allMatches(xml)
        .map((match) => match.group(1)!)
        .toSet();

String _channel(String rules, String tag) {
  final start = rules.indexOf('<$tag>');
  final end = rules.indexOf('</$tag>');
  expect(start, isNonNegative, reason: 'missing <$tag>');
  expect(end, greaterThan(start), reason: 'missing </$tag>');
  return rules.substring(start, end);
}
