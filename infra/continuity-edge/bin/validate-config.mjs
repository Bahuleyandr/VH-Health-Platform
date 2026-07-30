#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSecureContext } from 'node:tls';
import { pathToFileURL } from 'node:url';
import {
  loadLoggingIdentities,
  verifyLoggingIdentityMaterial,
} from '../lib/audit-log.mjs';
import { loadActivatedEdgeConfig } from '../lib/config.mjs';
import { assertProtectedFile } from '../lib/json-files.mjs';

async function assertDistinctPrivateKeys(config, identities) {
  const files = {
    sourcePull: config.rclone.identityPath,
    dropUpload: config.upload.identityPath,
    gatewayTls: config.gateway.tlsPrivateKeyPath,
  };
  for (const [location, identity] of Object.entries(identities)) {
    await assertProtectedFile(identity.certificatePath, {
      label: `logger:${location} certificate`,
      privateMode: true,
      ownerUid: 10001,
      ownerGid: 10001,
    });
    await verifyLoggingIdentityMaterial(identity);
    files[`logger:${location}`] = identity.privateKeyPath;
  }
  const hashes = new Map();
  for (const [purpose, file] of Object.entries(files)) {
    await assertProtectedFile(file, {
      label: `${purpose} private key`,
      privateMode: true,
      ownerUid: 10001,
      ownerGid: 10001,
    });
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    const prior = hashes.get(hash);
    if (prior) {
      throw new Error(
        `private keys must be distinct across ${prior} and ${purpose}`,
      );
    }
    hashes.set(hash, purpose);
  }
}

export async function main(env = process.env) {
  const config = await loadActivatedEdgeConfig(env);
  const [tlsKey, tlsCertificate, clientCa] = await Promise.all([
    readFile(config.gateway.tlsPrivateKeyPath),
    readFile(config.gateway.tlsCertificatePath),
    readFile(config.gateway.clientCaPath),
  ]);
  createSecureContext({
    key: tlsKey,
    cert: tlsCertificate,
    ca: clientCa,
    minVersion: 'TLSv1.2',
  });
  const identities = await loadLoggingIdentities(
    config.gateway.loggingIdentitiesPath,
    config.scope,
  );
  await assertDistinctPrivateKeys(config, identities);
  process.stdout.write(
    `edge configuration verified for ${config.scope.tenantId}/${config.scope.facilityId}\n`,
  );
  return config;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
