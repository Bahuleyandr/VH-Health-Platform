/// Authenticated dashboard shortcuts which keep standalone patient tools
/// discoverable without granting those routes to guest sessions.
const patientDashboardCareRoutes = <String>{
  '/chatbot',
  '/calendar',
  '/refill',
  '/family',
  '/reminders',
  '/portal/maternity/timeline',
};

/// Routes that intentionally have no persistent dashboard control because
/// they are startup aliases, notification entry points, or contextual portal
/// subflows. Every other non-parameterised router destination must have an
/// in-app navigation source.
const patientNavExcludedRoutes = <String, String>{
  '/': 'startup redirect',
  '/portal/lab-orders': 'notification and portal-context entry point',
  '/portal/discharge-summaries': 'hospital-documents contextual entry point',
  '/portal/tpa/claims': 'billing and notification contextual entry point',
  '/vitals': 'health record contextual and notification entry point',
  '/records': 'compatibility alias for Your Health',
  '/dashboard': 'compatibility alias for home',
};
