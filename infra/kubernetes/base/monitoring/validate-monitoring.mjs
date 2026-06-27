// infra/kubernetes/base/monitoring/validate-monitoring.mjs
// Validates the monitoring assets WITHOUT a cluster: promtool check rules over
// every PrometheusRule, and JSON.parse over every dashboard. Deploy is HELD, so
// alerts cannot be live-fired — this is the honest CI gate (structure + PromQL
// parse-validity), NOT proof that an alert fires.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ruleFiles = ['backend-reliability-alerts.yaml', 'backend-slo.yaml', 'backend-red-alerts.yaml', 'alert-rules.yaml'];

let failed = false;
for (const f of ruleFiles) {
  try {
    const out = execFileSync('promtool', ['check', 'rules', join(here, f)], { encoding: 'utf8' });
    console.log(`✓ ${f}\n${out.trim()}`);
  } catch (e) {
    failed = true;
    console.error(`✗ promtool check rules ${f}\n${e.stdout || ''}${e.stderr || e.message}`);
  }
}
const dashDir = join(here, 'dashboards');
for (const f of readdirSync(dashDir).filter((n) => n.endsWith('.json'))) {
  try {
    JSON.parse(readFileSync(join(dashDir, f), 'utf8'));
    console.log(`✓ dashboard JSON valid: ${f}`);
  } catch (e) {
    failed = true;
    console.error(`✗ invalid dashboard JSON ${f}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
