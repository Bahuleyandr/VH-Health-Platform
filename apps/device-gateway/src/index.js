import { BackendClient } from './backendClient.js';
import {
  defaultSpoolDir,
  enrollmentConfigFromEnv,
  GatewayRuntime,
  listenerConfigFromEnv,
  startGateway,
} from './gateway.js';

const backendClient = new BackendClient({
  baseUrl: process.env.BACKEND_BASE_URL || 'http://localhost:3000',
  token: process.env.DEVICE_GATEWAY_BACKEND_TOKEN || '',
  apiKey: process.env.DEVICE_GATEWAY_API_KEY || process.env.API_KEY || '',
});

const runtime = new GatewayRuntime({
  spoolDir: defaultSpoolDir(),
  backendClient,
  maxSpoolBytes: Number(process.env.DEVICE_GATEWAY_MAX_SPOOL_BYTES || 50 * 1024 * 1024),
  enrollments: enrollmentConfigFromEnv(),
});

await startGateway({
  listeners: listenerConfigFromEnv(),
  runtime,
  metricsPort: Number(process.env.DEVICE_GATEWAY_METRICS_PORT || 9108),
  coldChainIngestPort: Number(process.env.DEVICE_GATEWAY_COLD_CHAIN_PORT || 8088),
});

console.log('VH Health device gateway listening');
