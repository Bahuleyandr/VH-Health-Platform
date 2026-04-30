/**
 * Pluggable KMS provider for PHI envelope encryption (Phase E3).
 *
 * The default `EnvKmsProvider` reads the master key (KEK) from the
 * `KMS_MASTER_KEY` env var (32-byte raw, base64-encoded). Production
 * deployments should swap in `AwsKmsProvider`, `GcpKmsProvider`, or
 * `VaultKmsProvider` (stub interfaces below — wire to the cloud SDK
 * when those keys are provisioned).
 *
 * The provider's job is simple: wrap and unwrap a 32-byte DEK.
 * The encryption of the actual PHI payload is done by phiEnvelopeService
 * using the unwrapped DEK with AES-256-GCM.
 */

import crypto from 'crypto';

const KEK_ALGORITHM = 'aes-256-gcm';
const KEK_IV_BYTES = 12; // GCM standard nonce size
const DEK_BYTES = 32;    // AES-256 data key

let _activeProvider = null;

export class EnvKmsProvider {
  constructor({ masterKeyBase64, keyId = 'env-default' } = {}) {
    const raw = masterKeyBase64 || process.env.KMS_MASTER_KEY;
    if (!raw) {
      throw new Error('EnvKmsProvider requires KMS_MASTER_KEY (32 bytes base64)');
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(`KMS_MASTER_KEY must decode to 32 bytes (got ${buf.length})`);
    }
    this.kek = buf;
    this.keyId = keyId;
    this.providerName = 'env';
  }

  generateDek() {
    return crypto.randomBytes(DEK_BYTES);
  }

  /**
   * Wrap a DEK by AES-GCM-encrypting it with the KEK. Returns
   * `{ edek, edek_iv, edek_tag, kid }` — all bytes raw, callers serialize.
   */
  wrapDek(dek) {
    if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
      throw new Error(`DEK must be a ${DEK_BYTES}-byte Buffer`);
    }
    const iv = crypto.randomBytes(KEK_IV_BYTES);
    const cipher = crypto.createCipheriv(KEK_ALGORITHM, this.kek, iv);
    const edek = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      edek,
      edek_iv: iv,
      edek_tag: tag,
      kid: this.keyId,
    };
  }

  /**
   * Unwrap a previously-wrapped DEK. Throws if `kid` doesn't match
   * (a different provider/version is needed).
   */
  unwrapDek({ edek, edek_iv, edek_tag, kid }) {
    if (kid && kid !== this.keyId) {
      const err = new Error(`KMS kid mismatch: envelope uses ${kid}, provider is ${this.keyId}`);
      err.code = 'KMS_KID_MISMATCH';
      throw err;
    }
    const decipher = crypto.createDecipheriv(KEK_ALGORITHM, this.kek, Buffer.from(edek_iv));
    decipher.setAuthTag(Buffer.from(edek_tag));
    return Buffer.concat([decipher.update(Buffer.from(edek)), decipher.final()]);
  }
}

/**
 * Stub for AWS KMS — swap in the real `@aws-sdk/client-kms` when
 * deploying to AWS. Same interface as EnvKmsProvider.
 */
export class AwsKmsProvider {
  // eslint-disable-next-line no-unused-vars
  constructor(opts) {
    throw new Error('AwsKmsProvider not yet implemented — install @aws-sdk/client-kms and wire it up');
  }
}

/**
 * Stub for Hashicorp Vault transit engine.
 */
export class VaultKmsProvider {
  // eslint-disable-next-line no-unused-vars
  constructor(opts) {
    throw new Error('VaultKmsProvider not yet implemented — wire to Vault transit engine');
  }
}

/**
 * Resolve the active provider. Reads `KMS_PROVIDER` env var; defaults
 * to `env`. Cached after first call so repeated calls are cheap.
 */
export function getKmsProvider({ refresh = false } = {}) {
  if (_activeProvider && !refresh) return _activeProvider;
  const provider = (process.env.KMS_PROVIDER || 'env').toLowerCase();
  switch (provider) {
    case 'env':
      _activeProvider = new EnvKmsProvider({ keyId: process.env.KMS_KEY_ID || 'env-default' });
      break;
    case 'aws-kms':
      _activeProvider = new AwsKmsProvider({});
      break;
    case 'vault':
      _activeProvider = new VaultKmsProvider({});
      break;
    default:
      throw new Error(`Unknown KMS_PROVIDER: ${provider}`);
  }
  return _activeProvider;
}

export function resetKmsProviderForTesting() {
  _activeProvider = null;
}

export const __testing__ = { KEK_ALGORITHM, KEK_IV_BYTES, DEK_BYTES };

export default { EnvKmsProvider, AwsKmsProvider, VaultKmsProvider, getKmsProvider };
