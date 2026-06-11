function envFlag(env, name) {
  return String(env?.[name] || '').toLowerCase() === 'true';
}

export function isProductionEnv(env = process.env) {
  return String(env?.NODE_ENV || '').toLowerCase() === 'production';
}

export function isLegacyPhoneAuthAllowed(env = process.env) {
  return !isProductionEnv(env) && envFlag(env, 'ENABLE_LEGACY_PHONE_AUTH');
}

export function isDevAuthEnabled(env = process.env) {
  return !isProductionEnv(env) && envFlag(env, 'ENABLE_DEV_AUTH');
}
