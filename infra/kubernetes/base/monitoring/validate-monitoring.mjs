// infra/kubernetes/base/monitoring/validate-monitoring.mjs
// Validates the monitoring assets WITHOUT a cluster: promtool check rules over
// every PrometheusRule, and JSON.parse over every dashboard. Deploy is HELD, so
// alerts cannot be live-fired — this is the honest CI gate (structure + PromQL
// parse-validity), NOT proof that an alert fires.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ruleFiles = ['backend-reliability-alerts.yaml', 'backend-slo.yaml', 'backend-red-alerts.yaml', 'alert-rules.yaml'];

let failed = false;
for (const f of ruleFiles) {
  const tempDir = mkdtempSync(join(tmpdir(), 'vhhealth-prom-rules-'));
  try {
    const promtoolFile = extractPrometheusRuleGroups(join(here, f), tempDir);
    const out = execFileSync('promtool', ['check', 'rules', promtoolFile], { encoding: 'utf8' });
    console.log(`✓ ${f}\n${out.trim()}`);
  } catch (e) {
    failed = true;
    console.error(`✗ promtool check rules ${f}\n${e.stdout || ''}${e.stderr || e.message}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
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

function extractPrometheusRuleGroups(filePath, tempDir) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const groupsIndex = lines.findIndex((line) => /^  groups:\s*$/.test(line));
  if (groupsIndex === -1) {
    return filePath;
  }

  const extracted = [];
  for (let i = groupsIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > groupsIndex && line.trim() !== '' && !line.startsWith('    ')) {
      break;
    }
    extracted.push(line.startsWith('  ') ? line.slice(2) : line);
  }

  const promtoolPath = join(tempDir, 'rules.yaml');
  writeFileSync(promtoolPath, `${extracted.join('\n')}\n`, 'utf8');
  return promtoolPath;
}
