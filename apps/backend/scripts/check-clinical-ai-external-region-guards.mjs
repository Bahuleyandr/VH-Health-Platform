#!/usr/bin/env node
// Fails CI if Clinical AI external-adapter region guardrails are removed.
//
// These are intentionally small string-presence checks. The unit suites prove
// behavior; this script catches future edits that add or simplify external
// adapter code without keeping the fail-closed tenant-region boundary visible.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const RULES = [
  {
    file: 'src/services/ai/localLlmClient.js',
    checks: [
      ['external provider allowlist env', 'CLINICAL_AI_EXTERNAL_REGIONS'],
      ['missing tenant region fails closed', 'if (!tenantRegion) return false;'],
      ['external provider block reason', 'externalRegionBlockReason'],
      ['blocked generation mode', "generationMode: 'blocked'"],
      ['blocked provider status', "providerStatus: 'blocked'"],
    ],
  },
  {
    file: 'src/services/ai/sttService.js',
    checks: [
      ['STT allowlist env', 'CLINICAL_AI_STT_ALLOWED_REGIONS'],
      ['shared external allowlist fallback', 'CLINICAL_AI_EXTERNAL_REGIONS'],
      ['missing tenant region fails closed', 'if (!tenantRegion) return false;'],
      ['blocked STT reason', "reason: 'tenant_region_not_allowed_for_stt'"],
      ['blocked STT status', "? 'skipped' : 'blocked'"],
      ['status exposes allowed regions', 'allowed_regions'],
    ],
  },
  {
    file: 'src/services/ai/ambientDiarizationService.js',
    checks: [
      ['diarization allowlist env', 'CLINICAL_AI_DIARIZATION_ALLOWED_REGIONS'],
      ['missing tenant region fails closed', 'if (!tenantRegion) return false;'],
      ['blocked diarization reason', "reason: 'tenant_region_not_allowed_for_diarization'"],
      ['status exposes allowed regions', 'allowed_regions'],
    ],
  },
  {
    file: 'src/services/ai/imagingPacsAdapterService.js',
    checks: [
      ['PACS allowlist env', 'CLINICAL_AI_PACS_ALLOWED_REGIONS'],
      ['missing tenant region fails closed', 'if (!tenantRegion) return false;'],
      ['blocked PACS reason', "reason: 'tenant_region_not_allowed_for_pacs'"],
      ['status exposes allowed regions', 'allowed_regions'],
    ],
  },
  {
    file: 'src/services/ai/priorAuthorizationPayerAdapterService.js',
    checks: [
      ['payer allowlist env', 'PRIOR_AUTH_PAYER_ALLOWED_REGIONS'],
      ['missing tenant region fails closed', 'if (!tenantRegion) return false;'],
      ['blocked payer reason', "reason: 'tenant_region_not_allowed_for_payer'"],
      ['status exposes allowed regions', 'allowed_regions'],
    ],
  },
];

const failures = [];

for (const rule of RULES) {
  const absolutePath = path.join(ROOT, rule.file);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${rule.file}: file is missing`);
    continue;
  }

  const source = fs.readFileSync(absolutePath, 'utf8');
  for (const [label, needle] of rule.checks) {
    if (!source.includes(needle)) {
      failures.push(`${rule.file}: missing ${label} (${needle})`);
    }
  }
}

if (failures.length) {
  console.error('');
  console.error('Clinical AI external adapter region guard check failed:');
  console.error('');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('');
  console.error('External Clinical AI adapters must fail closed when tenant region is missing or not allowlisted.');
  process.exit(1);
}

console.log(`Clinical AI external adapter region guard check passed (${RULES.length} adapters scanned)`);
