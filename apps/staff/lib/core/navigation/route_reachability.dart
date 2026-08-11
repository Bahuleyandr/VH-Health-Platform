/// Router destinations which are intentionally contextual, external-entry, or
/// compatibility-only rather than dashboard/workbench navigation items.
const staffNavExcludedRoutes = <String, String>{
  '/': 'startup redirect',
  '/login': 'authentication entry point',
  '/clinical-continuity': 'operator-only continuity recovery entry point',
  '/clinical-continuity/reconciliation':
      'contextual reconciliation flow from continuity recovery',
  '/phone/queries': 'phone self-service subpage',
  '/phone/patient-lookup': 'phone self-service subpage',
  '/reception-counter': 'front-office contextual counter view',
  '/appointment-queue': 'legacy front-office redirect',
  '/clinical-ai/compose': 'clinical AI contextual compose flow',
  '/clinical-ai/voice-notes': 'clinical AI contextual voice-note flow',
  '/vitals': 'patient-context clinical entry point',
  '/mar/due': 'medication administration contextual queue',
  '/reports-grievances/admin': 'reports hub administrative subpage',
  '/payroll/queries': 'payroll self-service subpage',
  '/payroll/declarations': 'payroll self-service subpage',
  '/payroll/tax-summary': 'payroll self-service subpage',
  '/about': 'settings subpage',
  '/order-sets': 'patient-context order-set flow',
};
