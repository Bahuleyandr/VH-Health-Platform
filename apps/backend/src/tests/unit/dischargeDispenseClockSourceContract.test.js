import { readFileSync } from 'node:fs';

const inventory = readFileSync(new URL('../../services/pharmacy/pharmacyOrderInventoryService.js', import.meta.url), 'utf8');
const admission = readFileSync(new URL('../../services/emr/admissionService.js', import.meta.url), 'utf8');

it('keeps the held substitution writer on the database clock without releasing its funding gate', () => {
  const start = inventory.indexOf('export async function dispenseSubstitutionCommand(');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = inventory.slice(start);
  const fundingGate = body.indexOf('requireSubstitutionFundingReauthorisation(');
  const clock = body.indexOf('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS recorded_at_epoch_ms');
  expect(fundingGate).toBeGreaterThanOrEqual(0);
  expect(clock).toBeGreaterThan(fundingGate);
  expect(body).toContain('const recordedAtMs = epochMsOrNull(clock?.recorded_at_epoch_ms)');
  expect(body).toContain('const dispensedAt = new Date(recordedAtMs)');
  expect(body).toContain('dispensed_at = $15::timestamptz');
  expect(body).toMatch(/clinicalItemsSha256,\s+dispensedAt\.toISOString\(\),/);
  expect(body).toContain('dispensed_at: dispensedAt.toISOString()');
  expect(body).toContain('occurredAt: dispensedAt,');
  expect(body).toContain('occurredAt: dispensedAt.toISOString(),');
  expect(body).not.toMatch(/dispensed_at\s*=\s*NOW\(\)/);
});

it('retains the exact evidence freshness predicate and actual dispenser requirement', () => {
  const start = admission.indexOf('async function hasDischargeMedicationEvidence(');
  const end = admission.indexOf('async function markDischargeDrugsDispensed(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const evidence = admission.slice(start, end);
  expect(evidence).toContain('po.dispensed_at >= $3::timestamptz');
  expect(evidence).toContain('po.dispensed_by IS NOT NULL');
  expect(evidence).toContain("LOWER(po.status) IN ('dispensed', 'delivered')");
  expect(evidence).not.toMatch(/INTERVAL|GREATEST|clock_timestamp|Date\.now/);
});
