import path from 'node:path';
import {
  DIGEST_IMAGE_PATTERN,
  normalizeFacilityId,
  normalizeTenantId,
} from './constants.mjs';
import { loadAndVerifyActivationReceipt } from './activation-receipt.mjs';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function absolute(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.resolve(value);
}

function positivePort(env, name) {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function digestImage(value, name) {
  if (
    !DIGEST_IMAGE_PATTERN.test(value) ||
    value.endsWith(`sha256:${'0'.repeat(64)}`)
  ) {
    throw new Error(`${name} must use a non-placeholder digest pin`);
  }
  return value;
}

function within(directory, target) {
  const relative = path.relative(directory, target);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

export function loadEdgeConfig(env = process.env) {
  if (required(env, 'VHEDGE_ACTIVATION_APPROVED') !== 'true') {
    throw new Error('VHEDGE_ACTIVATION_APPROVED must be exactly true');
  }
  if (required(env, 'VHEDGE_CLOCK_TRUSTED') !== 'true') {
    throw new Error('VHEDGE_CLOCK_TRUSTED must be exactly true');
  }
  const dataRoot = absolute(env, 'VHEDGE_DATA_ROOT');
  const logRoot = absolute(env, 'VHEDGE_LOG_ROOT');
  const config = {
    scope: {
      tenantId: normalizeTenantId(required(env, 'VHEDGE_TENANT_ID')),
      facilityId: normalizeFacilityId(required(env, 'VHEDGE_FACILITY_ID')),
    },
    dataRoot,
    logRoot,
    runtimeRoot: absolute(env, 'VHEDGE_RUNTIME_ROOT'),
    activationReceiptPath: absolute(env, 'VHEDGE_ACTIVATION_RECEIPT_PATH'),
    trustedKeysPath: absolute(env, 'VHEDGE_TRUSTED_KEYS_PATH'),
    policyReceiptPath: absolute(env, 'VHEDGE_POLICY_RECEIPT_PATH'),
    floorsPath: absolute(env, 'VHEDGE_FLOORS_PATH'),
    bootstrapFloorsPath: absolute(env, 'VHEDGE_BOOTSTRAP_FLOORS_PATH'),
    prometheusPath: absolute(env, 'VHEDGE_PROMETHEUS_TEXTFILE_PATH'),
    rclone: {
      binary: required(env, 'VHEDGE_RCLONE_BINARY'),
      configFile: absolute(env, 'VHEDGE_RCLONE_CONFIG'),
      remote: required(env, 'VHEDGE_SOURCE_REMOTE'),
      facilityPath: required(env, 'VHEDGE_SOURCE_FACILITY_PATH'),
      identityPath: absolute(env, 'VHEDGE_SOURCE_PULL_IDENTITY_PATH'),
      knownHostsPath: absolute(env, 'VHEDGE_SOURCE_KNOWN_HOSTS_PATH'),
    },
    gateway: {
      listenHost: required(env, 'VHEDGE_LISTEN_HOST'),
      listenPort: positivePort(env, 'VHEDGE_LISTEN_PORT'),
      tlsCertificatePath: absolute(env, 'VHEDGE_TLS_CERTIFICATE_PATH'),
      tlsPrivateKeyPath: absolute(env, 'VHEDGE_TLS_PRIVATE_KEY_PATH'),
      clientCaPath: absolute(env, 'VHEDGE_CLIENT_CA_PATH'),
      caddyOrigin: required(env, 'VHEDGE_CADDY_ORIGIN'),
      loggingIdentitiesPath: absolute(env, 'VHEDGE_LOGGING_IDENTITIES_PATH'),
    },
    upload: {
      rsyncBinary: required(env, 'VHEDGE_RSYNC_BINARY'),
      sshBinary: required(env, 'VHEDGE_SSH_BINARY'),
      identityPath: absolute(env, 'VHEDGE_DROP_UPLOAD_IDENTITY_PATH'),
      knownHostsPath: absolute(env, 'VHEDGE_DROP_KNOWN_HOSTS_PATH'),
      destination: required(env, 'VHEDGE_DROP_DESTINATION'),
    },
  };
  if (
    config.gateway.caddyOrigin !== 'http://127.0.0.1:8080' &&
    config.gateway.caddyOrigin !== 'http://[::1]:8080'
  ) {
    throw new Error('VHEDGE_CADDY_ORIGIN must be the pinned loopback listener');
  }
  if (!within(path.join(dataRoot, 'state'), config.floorsPath)) {
    throw new Error('VHEDGE_FLOORS_PATH must be below VHEDGE_DATA_ROOT/state');
  }
  if (!within(path.join(dataRoot, 'metrics'), config.prometheusPath)) {
    throw new Error(
      'VHEDGE_PROMETHEUS_TEXTFILE_PATH must be below VHEDGE_DATA_ROOT/metrics',
    );
  }
  digestImage(required(env, 'VHEDGE_CADDY_IMAGE'), 'VHEDGE_CADDY_IMAGE');
  digestImage(required(env, 'VHEDGE_GATEWAY_IMAGE'), 'VHEDGE_GATEWAY_IMAGE');
  return config;
}

export async function loadActivatedEdgeConfig(env = process.env) {
  const config = loadEdgeConfig(env);
  await loadAndVerifyActivationReceipt(
    config.activationReceiptPath,
    config.scope,
  );
  return config;
}

export function currentTrustedNow() {
  return new Date().toISOString();
}
