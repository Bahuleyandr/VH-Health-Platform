import { BackendClient, backendTimeoutMsFromEnv } from './backendClient.js';
import {
  coldChainPortFromEnv,
  defaultSpoolDir,
  enrollmentConfigFromEnv,
  GatewayRuntime,
  legacyIngestEnabledFromEnv,
  listenerConfigFromEnv,
  startGateway,
} from './gateway.js';

const backendClient = new BackendClient({
  baseUrl: process.env.BACKEND_BASE_URL || 'http://localhost:3000',
  token: process.env.DEVICE_GATEWAY_BACKEND_TOKEN || '',
  apiKey: process.env.DEVICE_GATEWAY_API_KEY || process.env.API_KEY || '',
  timeoutMs: backendTimeoutMsFromEnv(),
});

const runtime = new GatewayRuntime({
  spoolDir: defaultSpoolDir(),
  backendClient,
  maxSpoolBytes: Number(process.env.DEVICE_GATEWAY_MAX_SPOOL_BYTES || 50 * 1024 * 1024),
  enrollments: enrollmentConfigFromEnv(),
  allowLegacy: legacyIngestEnabledFromEnv(),
});

const started = await startGateway({
  listeners: listenerConfigFromEnv(),
  runtime,
  metricsPort: Number(process.env.DEVICE_GATEWAY_METRICS_PORT || 9108),
  coldChainIngestPort: coldChainPortFromEnv(),
});

console.log('VH Health device gateway listening');

// Graceful shutdown: stop accepting new connections, let in-flight frames
// finish their durable spool append + ACK, then exit. Kubernetes sends
// SIGTERM on pod stop; SIGINT covers an operator's Ctrl-C. Registered once —
// a second signal during shutdown kills the process immediately (default
// disposition), which is the correct escape hatch for a wedged drain.
const shutdownTimeoutMs = Number(process.env.DEVICE_GATEWAY_SHUTDOWN_TIMEOUT_MS || 10000);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`device-gateway: ${signal} received, shutting down gracefully`);
    started.shutdown({ drainTimeoutMs: shutdownTimeoutMs })
      .then(() => {
        console.log('device-gateway: shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        console.error(`device-gateway: shutdown failed: ${err?.code || err?.message || err}`);
        process.exit(1);
      });
  });
}
