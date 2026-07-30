import {
  exactKeys,
} from './constants.mjs';
import { readProtectedJson } from './json-files.mjs';

function normalizeKeyMap(value, { policy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('trusted-key maps must be objects');
  }
  const normalized = {};
  for (const [keyId, entry] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(keyId) ||
      !exactKeys(entry, ['algorithm', 'keyId', 'publicKey', 'state']) ||
      entry.keyId !== keyId ||
      entry.algorithm !== 'Ed25519' ||
      typeof entry.publicKey !== 'string' ||
      !entry.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')
    ) {
      throw new Error(`trusted key ${keyId} is invalid`);
    }
    const allowedStates = policy
      ? new Set(['active', 'retiring', 'revoked', 'compromised'])
      : new Set(['current', 'next', 'revoked', 'compromised']);
    if (!allowedStates.has(entry.state)) {
      throw new Error(`trusted key ${keyId} has an unsupported state`);
    }
    normalized[keyId] = { ...entry };
  }
  return normalized;
}

export function normalizeTrustedKeys(value) {
  if (!exactKeys(value, ['packKeys', 'policyKeys'])) {
    throw new Error('trusted-keys file must contain only packKeys and policyKeys');
  }
  const packKeys = normalizeKeyMap(value.packKeys);
  const policyKeys = normalizeKeyMap(value.policyKeys, { policy: true });
  if (Object.values(packKeys).every((entry) => entry.state !== 'current')) {
    throw new Error('trusted-keys file has no current pack key');
  }
  if (Object.values(policyKeys).every((entry) => entry.state !== 'active')) {
    throw new Error('trusted-keys file has no active policy key');
  }
  return { packKeys, policyKeys };
}

export async function loadTrustedKeys(file) {
  return normalizeTrustedKeys(
    await readProtectedJson(file, { label: 'trusted-keys file' }),
  );
}
