#!/usr/bin/env node

import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env', import.meta.url) });

import { runSyntheticSiemDrill } from '../src/services/security/siemExportService.js';
import { DEFAULT_TENANT_ID } from '../src/services/tenant/tenantService.js';

function parseArgs(argv) {
  const args = {
    tenantId: process.env.SIEM_EXPORT_TENANT_ID || DEFAULT_TENANT_ID,
    targetKey: process.env.SIEM_EXPORT_TARGET_KEY || 'synthetic-object-drop',
    transport: process.env.SIEM_EXPORT_TRANSPORT || 'object_drop',
    objectDropDir: process.env.SIEM_EXPORT_OBJECT_DROP_DIR || null,
    endpointUrl: process.env.SIEM_EXPORT_WEBHOOK_URL || null,
    syslogHost: process.env.SIEM_EXPORT_SYSLOG_HOST || null,
    syslogPort: process.env.SIEM_EXPORT_SYSLOG_PORT || null,
    severity: 'critical',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant-id') args.tenantId = argv[++i] || args.tenantId;
    else if (arg.startsWith('--tenant-id=')) args.tenantId = arg.slice('--tenant-id='.length);
    else if (arg === '--target-key') args.targetKey = argv[++i] || args.targetKey;
    else if (arg.startsWith('--target-key=')) args.targetKey = arg.slice('--target-key='.length);
    else if (arg === '--transport') args.transport = argv[++i] || args.transport;
    else if (arg.startsWith('--transport=')) args.transport = arg.slice('--transport='.length);
    else if (arg === '--out-dir') args.objectDropDir = argv[++i] || args.objectDropDir;
    else if (arg.startsWith('--out-dir=')) args.objectDropDir = arg.slice('--out-dir='.length);
    else if (arg === '--endpoint-url') args.endpointUrl = argv[++i] || args.endpointUrl;
    else if (arg.startsWith('--endpoint-url=')) args.endpointUrl = arg.slice('--endpoint-url='.length);
    else if (arg === '--syslog-host') args.syslogHost = argv[++i] || args.syslogHost;
    else if (arg.startsWith('--syslog-host=')) args.syslogHost = arg.slice('--syslog-host='.length);
    else if (arg === '--syslog-port') args.syslogPort = argv[++i] || args.syslogPort;
    else if (arg.startsWith('--syslog-port=')) args.syslogPort = arg.slice('--syslog-port='.length);
    else if (arg === '--severity') args.severity = argv[++i] || args.severity;
    else if (arg.startsWith('--severity=')) args.severity = arg.slice('--severity='.length);
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node apps/backend/scripts/smoke-siem-export-drill.mjs [options]

Options:
  --tenant-id <uuid>       Tenant to drill. Defaults to SIEM_EXPORT_TENANT_ID or default tenant.
  --target-key <key>       SIEM target key to upsert/use. Defaults to synthetic-object-drop.
  --transport <name>       object_drop, webhook, or syslog. Defaults to object_drop.
  --out-dir <path>         Object-drop directory for local drill evidence.
  --endpoint-url <url>     Webhook URL when --transport=webhook.
  --syslog-host <host>     Syslog host when --transport=syslog.
  --syslog-port <port>     Syslog UDP port when --transport=syslog.
  --severity <level>       high or critical. Defaults to critical.
`);
}

const args = parseArgs(process.argv.slice(2));
const result = await runSyntheticSiemDrill(args);

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

console.log(JSON.stringify({
  ok: result.dispatch.succeeded > 0,
  tenant_id: result.tenant_id,
  target_key: result.target_key,
  transport: result.transport,
  enqueue: result.enqueue,
  dispatch: result.dispatch,
  evidence: result.evidence,
  redaction_policy: result.event.minimized_payload?.redaction,
}, jsonReplacer, 2));

process.exit(result.dispatch.succeeded > 0 ? 0 : 1);
