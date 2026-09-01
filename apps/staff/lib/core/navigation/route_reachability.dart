/// Router destinations which are intentionally contextual, external-entry, or
/// compatibility-only rather than dashboard/workbench navigation items.
const staffNavExcludedRoutes = <String, String>{
  '/': 'startup redirect',
  '/login': 'authentication entry point',
  '/clinical-continuity': 'operator-only continuity recovery entry point',
  '/clinical-continuity/reconciliation':
      'contextual reconciliation flow from continuity recovery',
  '/clinical-inbox/recovery':
      'platform-admin alert delivery recovery workbench and task deep link',
  '/phone/queries': 'phone self-service subpage',
  '/phone/patient-lookup': 'phone self-service subpage',
  '/appointment-queue': 'legacy front-office redirect',
  '/billing/credit-notes':
      'billing desk contextual subpage for credit-note review and payout',
  '/billing/refunds':
      'targeted counter-sale refund approval and payout task deep link',
  '/billing/gateway-refund-reconciliation': 'platform-admin provider-refund recovery queue and notification deep link',
  '/clinical-ai/compose': 'clinical AI contextual compose flow',
  '/clinical-ai/voice-notes': 'clinical AI contextual voice-note flow',
  '/vitals': 'patient-context clinical entry point',
  '/mar/due': 'medication administration contextual queue',
  '/mar/reconcile/:maId':
      'domain-evidence MAR supply reconciliation task entry point',
  '/reports-grievances/admin': 'reports hub administrative subpage',
  '/shift-swaps': 'schedule contextual subpage (shift swaps + on-call)',
  '/pharmacy/counter-sale':
      'pharmacy workspace contextual subpage (walk-in counter point-of-sale)',
  '/pharmacy/cath-inventory-reconciliation':
      'targeted Cath consumable inventory-reconciliation task deep link',
  '/dietary/kitchen':
      'dietary workspace contextual subpage (kitchen board + tray tracking)',
  '/ambulance-tracking':
      'ED workbench contextual subpage (ambulance live GPS tracking)',
  '/payroll/queries': 'payroll self-service subpage',
  '/payroll/declarations': 'payroll self-service subpage',
  '/payroll/tax-summary': 'payroll self-service subpage',
  '/about': 'settings subpage',
};
