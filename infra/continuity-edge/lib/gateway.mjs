import https from 'node:https';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendAuditEvent,
  loadLoggingIdentities,
  sealAuditBatch,
} from './audit-log.mjs';
import {
  authorizeEdgeRead,
  authorizeLoggingIdentity,
  certificateSha256,
  parseGatewayPath,
} from './authorization.mjs';
import { withVerifiedCurrentState } from './current-state.mjs';
import { sha256Hex } from './pointer.mjs';
import { recordVerificationFailure, defaultMetricPaths } from './metrics.mjs';

function oneHeader(request, name) {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.length === 0 || value.includes(',')) {
    throw new Error(`${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  }
  return value;
}

function noStoreHeaders(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function denied(response, status = 403) {
  noStoreHeaders(response);
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Continuity access denied.\n');
}

async function proxyAsset({
  request,
  response,
  caddyOrigin,
  selection,
  location,
}) {
  const upstream = new URL(caddyOrigin);
  const assetPath = [
    '',
    'continuity-v1',
    'tenants',
    location.tenantId,
    'facilities',
    String(location.facilityId),
    selection.pointer.set,
    'locations',
    location.locationType,
    location.locationIdentifier,
    location.asset,
  ].join('/');
  return new Promise((resolve, reject) => {
    const proxy = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: assetPath,
        headers: { Host: '127.0.0.1' },
        timeout: 5_000,
      },
      (upstreamResponse) => {
        noStoreHeaders(response);
        response.statusCode = upstreamResponse.statusCode || 502;
        for (const header of ['content-type', 'content-length', 'last-modified']) {
          const value = upstreamResponse.headers[header];
          if (value !== undefined) response.setHeader(header, value);
        }
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', resolve);
      },
    );
    proxy.on('timeout', () => proxy.destroy(new Error('Caddy timeout')));
    proxy.on('error', reject);
    proxy.end();
  });
}

async function withVerifiedGatewayState({
  config,
  runtime,
  trustedNow,
  callback,
}) {
  return withVerifiedCurrentState({
    dataRoot: config.dataRoot,
    scope: config.scope,
    runtime,
    trustedNow,
    floorsPath: config.floorsPath,
    bootstrapFloorsPath: config.bootstrapFloorsPath,
    trustedKeysPath: config.trustedKeysPath,
    policyReceiptPath: config.policyReceiptPath,
  }, async (state) => {
    const edgeAccess = state.selection.manifestEnvelope?.content?.edgeAccess;
    if (
      edgeAccess?.path !== 'edge-access.json' ||
      !/^[0-9a-f]{64}$/.test(String(edgeAccess.sha256 || ''))
    ) {
      throw new Error('MANIFEST_INVALID');
    }
    const edgeAccessBytes = await readFile(
      path.join(state.selection.setDirectory, edgeAccess.path),
    );
    if (sha256Hex(edgeAccessBytes) !== edgeAccess.sha256) {
      throw new Error('ASSET_HASH_MISMATCH');
    }
    const edgeAccessEnvelope = JSON.parse(edgeAccessBytes.toString('utf8'));
    return callback({ ...state, edgeAccessEnvelope });
  });
}

export function createGateway({ config, runtime, now = () => new Date() }) {
  const metricPaths = defaultMetricPaths(
    config.dataRoot,
    config.prometheusPath,
    config.scope.facilityId,
  );
  return https.createServer(
    {
      key: undefined,
      cert: undefined,
      ca: undefined,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      honorCipherOrder: true,
    },
    async (request, response) => {
      let location;
      let staffUid;
      let deviceId;
      let fingerprint;
      let loggingIdentity;
      let authorizationDecisionMade = false;
      try {
        if (!['GET', 'HEAD'].includes(request.method)) {
          denied(response, 405);
          return;
        }
        const url = new URL(request.url, 'https://continuity.invalid');
        location = parseGatewayPath(url.pathname);
        if (
          !location ||
          location.tenantId !== config.scope.tenantId ||
          location.facilityId !== config.scope.facilityId ||
          url.search !== ''
        ) {
          denied(response, 404);
          return;
        }
        staffUid = oneHeader(request, 'x-vhhealth-staff-uid').toLowerCase();
        deviceId = oneHeader(request, 'x-vhhealth-device-id');
        fingerprint = certificateSha256(request.socket);
        const trustedNow = now().toISOString();
        await withVerifiedGatewayState({
          config,
          runtime,
          trustedNow,
          callback: async (state) => {
            const identities = await loadLoggingIdentities(
              config.gateway.loggingIdentitiesPath,
              config.scope,
            );
            loggingIdentity =
              identities[
                `${location.locationType}/${location.locationIdentifier}`
              ];
            if (!loggingIdentity) {
              throw new Error('LOGGING_IDENTITY_NOT_CONFIGURED');
            }
            await authorizeLoggingIdentity({
              edgeAccessEnvelope: state.edgeAccessEnvelope,
              identity: loggingIdentity,
              trustedNow,
            });
            const grant = authorizeEdgeRead({
              edgeAccessEnvelope: state.edgeAccessEnvelope,
              policy: state.policy,
              floors: state.floors,
              scope: config.scope,
              location,
              staffUid,
              deviceId,
              clientCertificateSha256: fingerprint,
              trustedNow,
            });
            authorizationDecisionMade = true;
            await appendAuditEvent({
              logRoot: config.logRoot,
              identity: loggingIdentity,
              canonical: runtime.canonical,
              event: {
                occurredAt: trustedNow,
                staffUid,
                deviceId,
                clientCertificateSha256: fingerprint,
                accessGrantId: grant.grantId,
                method: request.method,
                asset: location.asset,
                outcome: 'authorized',
              },
            });
            await sealAuditBatch({
              logRoot: config.logRoot,
              identity: loggingIdentity,
              canonical: runtime.canonical,
            });
            await proxyAsset({
              request,
              response,
              caddyOrigin: config.gateway.caddyOrigin,
              selection: state.selection,
              location,
            });
          },
        });
      } catch (error) {
        const reason = error.reason || error.message || 'EDGE_GATEWAY_FAILED';
        if (
          loggingIdentity &&
          !authorizationDecisionMade &&
          staffUid &&
          deviceId &&
          fingerprint &&
          location
        ) {
          try {
            await appendAuditEvent({
              logRoot: config.logRoot,
              identity: loggingIdentity,
              canonical: runtime.canonical,
              event: {
                occurredAt: now().toISOString(),
                staffUid,
                deviceId,
                clientCertificateSha256: fingerprint,
                accessGrantId: null,
                method: request.method,
                asset: location.asset,
                outcome: 'denied',
              },
            });
            await sealAuditBatch({
              logRoot: config.logRoot,
              identity: loggingIdentity,
              canonical: runtime.canonical,
            });
          } catch (auditError) {
            const auditReason =
              auditError.reason || auditError.message || 'EDGE_AUDIT_FAILED';
            if (/^[A-Z][A-Z0-9_]{0,79}$/.test(auditReason)) {
              await recordVerificationFailure(metricPaths, auditReason).catch(() => {});
            }
          }
        }
        if (/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)) {
          await recordVerificationFailure(metricPaths, reason).catch(() => {});
        }
        if (!response.headersSent) denied(response);
        else response.destroy();
      }
    },
  );
}

export async function startGateway({ config, runtime }) {
  const [key, cert, ca] = await Promise.all([
    readFile(config.gateway.tlsPrivateKeyPath),
    readFile(config.gateway.tlsCertificatePath),
    readFile(config.gateway.clientCaPath),
  ]);
  const server = createGateway({ config, runtime });
  server.setSecureContext({ key, cert, ca, minVersion: 'TLSv1.2' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.gateway.listenPort, config.gateway.listenHost, resolve);
  });
  return server;
}
