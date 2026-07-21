const DEFAULT_RECONCILIATION_CRON = '*/15 * * * *';

function exactTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export function isPathwayReconciliationEnabled(env = process.env) {
  return exactTrue(env.CARE_PATHWAY_RECONCILIATION_ENABLED);
}

export function isPathwayReconciliationRepairEnabled(env = process.env) {
  return exactTrue(env.CARE_PATHWAY_RECONCILIATION_REPAIR_ENABLED);
}

export function pathwayReconciliationCron(env = process.env) {
  const value = String(env.CARE_PATHWAY_RECONCILIATION_CRON || '').trim();
  return value || DEFAULT_RECONCILIATION_CRON;
}

export default {
  isPathwayReconciliationEnabled,
  isPathwayReconciliationRepairEnabled,
  pathwayReconciliationCron,
};
