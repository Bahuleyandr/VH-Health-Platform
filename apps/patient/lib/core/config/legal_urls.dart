class LegalUrls {
  LegalUrls._();

  static const defaultPrivacyPolicyUrl = 'https://vhhealth.app/privacy-policy';
  static const defaultTermsUrl = 'https://vhhealth.app/terms';

  static const privacyPolicyUrl = String.fromEnvironment(
    'PRIVACY_POLICY_URL',
    defaultValue: defaultPrivacyPolicyUrl,
  );
  static const termsUrl = String.fromEnvironment(
    'TERMS_URL',
    defaultValue: defaultTermsUrl,
  );
}
