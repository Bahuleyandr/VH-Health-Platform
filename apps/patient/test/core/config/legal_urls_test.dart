import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/config/legal_urls.dart';

void main() {
  group('LegalUrls', () {
    test('defaults to HTTPS public legal pages', () {
      expect(LegalUrls.termsUrl, LegalUrls.defaultTermsUrl);
      expect(LegalUrls.privacyPolicyUrl, LegalUrls.defaultPrivacyPolicyUrl);
      expect(Uri.parse(LegalUrls.termsUrl).scheme, 'https');
      expect(Uri.parse(LegalUrls.privacyPolicyUrl).scheme, 'https');
    });
  });
}
