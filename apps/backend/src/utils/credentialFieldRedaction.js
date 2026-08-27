const CREDENTIAL_FIELD_NAMES = new Set([
  'password',
  'password_hash',
  'current_password',
  'new_password',
  'old_password',
  'confirm_password',
  'passcode',
  'otp',
  'pin',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'challenge_token',
  'device_token',
  'fcm_token',
  'bearer_token',
  'sender_bearer_token',
  'callback_token',
  'csrf_token',
  'secret',
  'encrypted_secret',
  'client_secret',
  'api_key',
  'apikey',
  'auth_key',
  'auth_token',
  'authorization',
  'auth_header',
  'key_secret',
  'webhook_secret',
  'cookie',
  'backup_code',
  'backup_codes',
]);

export function normalizeCredentialFieldName(value) {
  return String(value || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function isCredentialFieldName(value) {
  return CREDENTIAL_FIELD_NAMES.has(normalizeCredentialFieldName(value));
}

export default { isCredentialFieldName, normalizeCredentialFieldName };
