import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd(), '..', '..');

function runbook(name) {
  return readFileSync(resolve(ROOT, 'apps/backend/docs/RUNBOOKS', name), 'utf8');
}

describe('NL-7 P4 runbook command contract', () => {
  it('keeps the device gateway triage commands literal and actionable', () => {
    const text = runbook('device-gateway-triage.md');

    expect(text).toContain('kubectl -n vhhealth get pods -l app.kubernetes.io/name=device-gateway');
    expect(text).toContain("kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- sh -lc 'ls -lah /var/spool/vhhealth-device-gateway && wc -l /var/spool/vhhealth-device-gateway/*.ndjson 2>/dev/null || true'");
    expect(text).toContain("curl -fsS http://127.0.0.1:9108/metrics | grep -E 'gateway_spool_depth|gateway_spool_oldest_age_seconds|gateway_forward_failures_total|gateway_dead_letter_total'");
    expect(text).toContain('kubectl -n vhhealth exec deployment/device-gateway -c device-gateway -- node scripts/soak-replay.mjs --cycles=250 --duplicate-every=25');
  });

  it('keeps cold-chain and activation runbooks tied to held-manifest verification', () => {
    const coldChain = runbook('cold-chain-excursion-response.md');
    const activation = runbook('device-gateway-activation.md');

    expect(coldChain).toContain("SELECT e.id, u.unit_code, u.display_name, u.department, e.opened_at, e.peak_temp_c, e.status, e.corrective_action FROM cold_chain_excursions e JOIN cold_chain_units u ON u.id = e.unit_id WHERE e.status IN ('open', 'acknowledged') ORDER BY e.opened_at DESC LIMIT 20;");
    expect(activation).toContain('kustomize build infra/kubernetes/base/device-gateway');
    expect(activation).toContain('kubectl -n vhhealth-monitoring get prometheusrule vhhealth-device-gateway-alerts');
    expect(activation).toContain('RTLS remains contract-only unless a named vendor pilot is approved in the playbook decision log.');
  });

  it('adds device-originated Code Blue misfire evidence checks', () => {
    const text = runbook('code-blue-misfire.md');

    expect(text).toContain('artifact filter first');
    expect(text).toContain('FROM device_vital_suppression_counters');
    expect(text).toContain('a.end_reason');
    expect(text).toContain('/var/spool/vhhealth-device-gateway');
  });
});
