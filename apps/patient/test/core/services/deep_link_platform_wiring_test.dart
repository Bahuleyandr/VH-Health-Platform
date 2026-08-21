import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android registers only the bounded local custom-scheme contract', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    final deepLinkFilter = RegExp(
      r'<intent-filter>\s*<action android:name="android.intent.action.VIEW"\s*/>\s*'
      r'<category android:name="android.intent.category.DEFAULT"\s*/>\s*'
      r'<category android:name="android.intent.category.BROWSABLE"\s*/>\s*'
      r'<data\s+android:scheme="vhhealth"\s+android:host="app"\s+'
      r'android:pathPrefix="/"\s*/>\s*</intent-filter>',
      multiLine: true,
    );

    expect(manifest, contains('android:name="flutter_deeplinking_enabled"'));
    expect(manifest, contains('android:value="true"'));
    expect(deepLinkFilter.hasMatch(manifest), isTrue);
    expect(manifest, isNot(contains('android:autoVerify')));
    expect(manifest, isNot(contains('<data android:scheme="vhhealth" />')));
  });

  test('iOS registers the same scheme without claiming associated domains', () {
    final info = File('ios/Runner/Info.plist').readAsStringSync();
    final entitlements = File('ios/Runner/Runner.entitlements')
        .readAsStringSync();

    expect(info, contains('<key>CFBundleURLTypes</key>'));
    expect(info, contains('<string>com.vh.vhhealth.deeplink</string>'));
    expect(info, contains('<string>vhhealth</string>'));
    expect(info, contains('<key>FlutterDeepLinkingEnabled</key>'));
    expect(
      entitlements,
      isNot(contains('com.apple.developer.associated-domains')),
    );
  });
}
