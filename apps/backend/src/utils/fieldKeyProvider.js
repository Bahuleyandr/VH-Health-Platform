// src/utils/fieldKeyProvider.js
//
// Pluggable Key-Encryption-Key (KEK) provider for envelope field encryption.
//
// This is the abstraction that lets `fieldEncryption.js` do envelope
// encryption (enc:v2:) without hard-coding *where* the KEK comes from. The
// default implementation derives a LOCAL KEK from env material (zero-spend,
// no cloud dependency). A real KMS (Vault transit, AWS KMS, GCP KMS) can be
// slotted in later by implementing the same three-method interface and
// registering it via setKekProvider() — nothing in fieldEncryption.js changes.
//
// Provider interface (the contract a real KMS must satisfy):
//   getKek(keyId)                 -> Buffer | { keyId, kek }   (32-byte AES key for that keyId)
//   wrapDek(dek, { keyId })       -> { keyId, edek, wiv, wtag } (raw Buffers)
//   unwrapDek({ keyId, edek, wiv, wtag }) -> Buffer (the 32-byte DEK)
//   listKeyIds()                  -> string[]                  (all keyIds this provider can unwrap)
//
// For a remote KMS the wrap/unwrap would be a network call to KMS:Encrypt /
// KMS:Decrypt over the DEK; the rest of fieldEncryption.js is identical.
//
// === Local KEK key material ===
//   FIELD_ENCRYPTION_KEK        — preferred KEK master secret. If unset we fall
//                                 back to FIELD_ENCRYPTION_KEY material so that
//                                 nothing breaks when the new env is not yet
//                                 provisioned (the v1 single-key path also uses
//                                 FIELD_ENCRYPTION_KEY, so a default deployment
//                                 is internally consistent).
//   FIELD_ENCRYPTION_KEK_ID     — keyId stamped into every enc:v2: payload so we
//                                 know which KEK to unwrap with later. Default
//                                 'local-v1'.
//   FIELD_ENCRYPTION_KEK_OLD    — OPTIONAL previous KEK master secret, kept
//   FIELD_ENCRYPTION_KEK_OLD_ID   alongside FIELD_ENCRYPTION_KEK_OLD_ID so a
//                                 single process can unwrap DEKs that are still
//                                 wrapped under the old KEK (e.g. during a
//                                 rotation pass). Optional; unset = no old key.
//
// The KEK is NOT the raw env string — we run scryptSync over it (same KDF the
// legacy v1 path uses) so the at-rest key has full 256-bit entropy regardless
// of the human-supplied secret's shape, and so a leaked env value still costs
// a scrypt to turn into the actual AES key.

import crypto from 'crypto';
import logger from '../logging/logger.js';

const KEK_ALGORITHM = 'aes-256-gcm';
const KEK_LENGTH = 32; // AES-256
const WRAP_IV_LENGTH = 12; // GCM standard nonce
const DEK_LENGTH = 32; // AES-256 data key

// scrypt salt for KEK derivation. Distinct from the v1 field-key salt
// ('vh-field-encryption-v1') so the derived KEK can never equal the v1 data
// key even when both come from the same FIELD_ENCRYPTION_KEY material.
const KEK_KDF_SALT = 'vh-field-kek-v1';

export const DEFAULT_KEK_ID = 'local-v1';

/**
 * Local, env-backed KEK provider. Holds one or more derived 32-byte KEKs keyed
 * by keyId so it can wrap under the current KEK and unwrap under either the
 * current or a previous (rotation) KEK.
 */
export class LocalKekProvider {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.activeKeyId]   keyId to wrap NEW writes under.
   * @param {Object<string,Buffer>} [opts.keks]  keyId -> raw 32-byte KEK.
   */
  constructor({ activeKeyId, keks } = {}) {
    this.providerName = 'local-env';
    this._keks = new Map();

    if (keks) {
      for (const [id, buf] of Object.entries(keks)) {
        this._registerKek(id, buf);
      }
      this._activeKeyId = activeKeyId || Object.keys(keks)[0];
      return;
    }

    // Derive from env.
    const activeMaterial = process.env.FIELD_ENCRYPTION_KEK || process.env.FIELD_ENCRYPTION_KEY;
    if (!activeMaterial) {
      throw new Error(
        'FIELD_ENCRYPTION_KEK (or FIELD_ENCRYPTION_KEY fallback) must be set for envelope field encryption',
      );
    }
    this._activeKeyId = activeKeyId || process.env.FIELD_ENCRYPTION_KEK_ID || DEFAULT_KEK_ID;
    this._registerKek(this._activeKeyId, deriveKekFromMaterial(activeMaterial));

    // Optional previous KEK so a single process can unwrap legacy-wrapped DEKs
    // (used during rotation, or right after a KEK swap before re-wrap runs).
    const oldMaterial = process.env.FIELD_ENCRYPTION_KEK_OLD;
    const oldId = process.env.FIELD_ENCRYPTION_KEK_OLD_ID;
    if (oldMaterial && oldId && oldId !== this._activeKeyId) {
      this._registerKek(oldId, deriveKekFromMaterial(oldMaterial));
    }
  }

  _registerKek(keyId, buf) {
    if (!Buffer.isBuffer(buf) || buf.length !== KEK_LENGTH) {
      throw new Error(`KEK for "${keyId}" must be a ${KEK_LENGTH}-byte Buffer`);
    }
    this._keks.set(keyId, buf);
  }

  get activeKeyId() {
    return this._activeKeyId;
  }

  listKeyIds() {
    return [...this._keks.keys()];
  }

  /**
   * Return the raw 32-byte KEK for a keyId (defaults to the active KEK).
   * Throws if the keyId is unknown — callers must provision the old KEK env
   * before trying to unwrap data wrapped under a retired keyId.
   */
  getKek(keyId = this._activeKeyId) {
    const kek = this._keks.get(keyId);
    if (!kek) {
      throw new Error(
        `Unknown KEK keyId "${keyId}". Provision its material (FIELD_ENCRYPTION_KEK[_OLD]) before unwrapping.`,
      );
    }
    return kek;
  }

  /**
   * Wrap a 32-byte DEK under the KEK identified by keyId (default active).
   * Returns raw Buffers; the caller serialises them into the payload.
   * @returns {{ keyId: string, edek: Buffer, wiv: Buffer, wtag: Buffer }}
   */
  wrapDek(dek, { keyId = this._activeKeyId } = {}) {
    if (!Buffer.isBuffer(dek) || dek.length !== DEK_LENGTH) {
      throw new Error(`DEK must be a ${DEK_LENGTH}-byte Buffer`);
    }
    const kek = this.getKek(keyId);
    const wiv = crypto.randomBytes(WRAP_IV_LENGTH);
    const cipher = crypto.createCipheriv(KEK_ALGORITHM, kek, wiv);
    const edek = Buffer.concat([cipher.update(dek), cipher.final()]);
    const wtag = cipher.getAuthTag();
    return { keyId, edek, wiv, wtag };
  }

  /**
   * Unwrap a previously-wrapped DEK. Throws on tampering (GCM tag mismatch)
   * or unknown keyId.
   * @returns {Buffer} the 32-byte DEK.
   */
  unwrapDek({ keyId = this._activeKeyId, edek, wiv, wtag }) {
    const kek = this.getKek(keyId);
    const decipher = crypto.createDecipheriv(KEK_ALGORITHM, kek, Buffer.from(wiv));
    decipher.setAuthTag(Buffer.from(wtag));
    return Buffer.concat([decipher.update(Buffer.from(edek)), decipher.final()]);
  }

  /** Generate a fresh per-record DEK. */
  generateDek() {
    return crypto.randomBytes(DEK_LENGTH);
  }

  // --- W3: per-tenant KEKs ----------------------------------------------------
  // Per-tenant KEKs are random keys stored (wrapped under a master KEK) in the
  // encryption_keys table and loaded async by tenantKekProvider, then registered
  // here so the SYNC wrap/unwrap path can use them by their `t:<tenantId>:v1`
  // keyId. (Sync provider + async DB load → load-then-register.)

  /** Register an externally-loaded per-tenant KEK for sync wrap/unwrap. */
  registerTenantKek(keyId, kek) {
    this._registerKek(keyId, kek);
  }

  /** Is a KEK for this keyId loaded? Lets encrypt fall back to the global KEK
   *  when a tenant KEK has not been preloaded (rather than throwing). */
  hasKek(keyId) {
    return this._keks.has(keyId);
  }

  /** Evict a (crypto-shredded) tenant KEK from the in-process cache. */
  evictKek(keyId) {
    return this._keks.delete(keyId);
  }
}

/**
 * Derive a 32-byte KEK from arbitrary env material via scrypt. Same KDF family
 * as the v1 data-key derivation, distinct salt.
 */
export function deriveKekFromMaterial(material) {
  return crypto.scryptSync(String(material), KEK_KDF_SALT, KEK_LENGTH);
}

// --- Active provider singleton -------------------------------------------------

let _provider = null;

/**
 * Resolve the active KEK provider. Cached after first call so we don't re-run
 * scrypt on every encrypt/decrypt. A future KMS_FIELD_PROVIDER switch can be
 * added here; today the only impl is the local env-backed KEK.
 */
export function getKekProvider() {
  if (_provider) return _provider;
  _provider = new LocalKekProvider();
  if (!process.env.FIELD_ENCRYPTION_KEK && process.env.FIELD_ENCRYPTION_KEY) {
    // Visible breadcrumb that we're running on the compatibility fallback.
    logger.info(
      'fieldEncryption: FIELD_ENCRYPTION_KEK unset — deriving envelope KEK from FIELD_ENCRYPTION_KEY (compatibility fallback)',
    );
  }
  return _provider;
}

/**
 * Override the active provider (for tests or to slot in a real KMS).
 * Pass null to clear and force re-derivation from env on next getKekProvider().
 */
export function setKekProvider(provider) {
  _provider = provider;
}

/** Test hook — clears the cached provider. */
export function resetKekProviderForTesting() {
  _provider = null;
}

export const __testing__ = {
  KEK_ALGORITHM,
  KEK_LENGTH,
  WRAP_IV_LENGTH,
  DEK_LENGTH,
  KEK_KDF_SALT,
};

export default {
  LocalKekProvider,
  getKekProvider,
  setKekProvider,
  deriveKekFromMaterial,
  DEFAULT_KEK_ID,
};
