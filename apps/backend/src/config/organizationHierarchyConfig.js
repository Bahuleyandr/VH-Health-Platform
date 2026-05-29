export const ORGANIZATION_HIERARCHY_VERSION = 'vh-org-hierarchy-2026-05-v1';

export const HIERARCHY_RELATIONSHIP_TYPES = {
  GOVERNANCE: 'governance',
  WORK: 'work',
  LEAVE: 'leave',
  LEAVE_RECOMMENDATION: 'leave_recommendation',
};

export const ORGANIZATION_HIERARCHY_LANES = [
  {
    id: 'executive',
    title: 'Executive accountability',
    description: 'Final hospital accountability, platform administration, budget, policy, and escalation.',
  },
  {
    id: 'hr',
    title: 'HR and people operations',
    description: 'Leave, payroll, compliance, recruitment, staff files, and policy process.',
  },
  {
    id: 'clinical',
    title: 'Clinical governance',
    description: 'Medical, nursing, clinical documentation, patient-care authority, and clinical safety.',
  },
  {
    id: 'operations',
    title: 'Hospital operations',
    description: 'Reception, admissions, facilities, housekeeping, maintenance, transport, and daily logistics.',
  },
];

export const ORGANIZATION_HIERARCHY_NODES = [
  {
    id: 'ceo_coo',
    lane: 'executive',
    title: 'CEO / COO',
    subtitle: 'Executive leadership',
    role_codes: ['SUPER_ADMIN', 'ADMIN'],
    access_level: 'Admin access',
    responsibilities: [
      'Final administrative accountability',
      'Hospital-wide policy approval',
      'Executive escalation for unresolved operational or HR disputes',
      'Platform administration and sensitive configuration',
    ],
    boundaries: [
      'Admin access is not a silent clinical override',
      'Clinical sign-off still follows medical and nursing governance',
    ],
  },
  {
    id: 'hr_manager',
    lane: 'hr',
    title: 'HR Manager',
    subtitle: 'People operations lead',
    role_codes: ['HR_MANAGER'],
    recommended_role_codes: ['HR_STAFF'],
    access_level: 'HR lead access',
    responsibilities: [
      'Owns leave policy, payroll process, recruitment, onboarding, and compliance',
      'Approves HR team work and escalates exceptions to CEO / COO',
      'Coordinates leave decisions with the functional incharge for coverage-sensitive teams',
    ],
    boundaries: [
      'Does not issue clinical, nursing, housekeeping, or maintenance work instructions',
      'Cannot bypass departmental coverage sign-off for rosters',
    ],
  },
  {
    id: 'hr_personnel',
    lane: 'hr',
    title: 'HR Personnel',
    subtitle: 'HR operations team',
    role_codes: ['HR_STAFF'],
    access_level: 'HR staff access',
    responsibilities: [
      'Processes leave records, staff profiles, attendance disputes, payroll inputs, and documentation',
      'Flags policy or coverage exceptions to HR Manager',
    ],
    boundaries: [
      'Can process and record, but final approval depends on configured approval chain',
    ],
  },
  {
    id: 'medical_superintendent',
    lane: 'clinical',
    title: 'Medical Superintendent',
    subtitle: 'Medical governance lead',
    role_codes: ['MEDICAL_SUPERINTENDENT', 'CMO'],
    access_level: 'Clinical leadership access',
    responsibilities: [
      'Owns doctor duty placement, clinical escalation, clinical policy, and medical audit',
      'Approves medical coverage plans and doctor roster exceptions',
    ],
    boundaries: [
      'HR may process leave, but medical coverage risk belongs to medical leadership',
    ],
  },
  {
    id: 'doctors',
    lane: 'clinical',
    title: 'Duty Doctors / Doctors',
    subtitle: 'Medical team',
    role_codes: ['DUTY_DOCTOR', 'DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'],
    access_level: 'Clinical doctor access',
    responsibilities: [
      'Patient care, orders, progress notes, discharge summaries, and medical sign-off',
      'Raise coverage or clinical escalation needs to Medical Superintendent',
    ],
    boundaries: [
      'Cannot approve own leave or silently alter roster after publication',
    ],
  },
  {
    id: 'diagnostics_services',
    lane: 'clinical',
    title: 'Diagnostics / Lab / Radiology',
    subtitle: 'Clinical diagnostic services',
    role_codes: ['PATHOLOGIST', 'RADIOLOGIST', 'LAB_STAFF'],
    access_level: 'Diagnostic service access',
    responsibilities: [
      'Laboratory and radiology reporting, diagnostic quality, and clinical investigation support',
      'Escalates clinical reporting or safety concerns to Medical Superintendent',
    ],
    boundaries: [
      'Cannot issue ward, reception, housekeeping, or maintenance roster instructions',
    ],
  },
  {
    id: 'nursing_superintendent',
    lane: 'clinical',
    title: 'Nursing Superintendent',
    subtitle: 'Nursing governance lead',
    role_codes: ['CNO'],
    recommended_role_codes: ['NURSING_SUPERINTENDENT'],
    access_level: 'Nursing leadership access',
    responsibilities: [
      'Owns nursing deployment, nursing documentation governance, ward coverage, and nursing escalation',
      'Approves nursing roster exceptions with HR process support',
    ],
    boundaries: [
      'Clinical nursing supervision stays within nursing leadership, not HR paperwork flow',
    ],
  },
  {
    id: 'nursing_incharge',
    lane: 'clinical',
    title: 'Nursing Incharge / OP Incharge',
    subtitle: 'Unit nursing leads',
    role_codes: ['NURSING_INCHARGE', 'OP_INCHARGE'],
    access_level: 'Unit roster and nursing work access',
    responsibilities: [
      'Assigns nurses to wards, OP areas, and coverage blocks',
      'Recommends leave approval or alternate arrangements based on coverage',
    ],
    boundaries: [
      'Does not replace HR approval records or payroll processing',
    ],
  },
  {
    id: 'nursing_staff',
    lane: 'clinical',
    title: 'Nursing Staff / OP Staff Nurse',
    subtitle: 'Nursing team',
    role_codes: ['NURSING_STAFF', 'OP_STAFF_NURSE', 'ICU_NURSE'],
    access_level: 'Nursing workflow access',
    responsibilities: [
      'Ward and OP nursing tasks, vitals, medication administration, nursing notes, and patient handover',
    ],
    boundaries: [
      'Leave preferences go through HR process and nursing coverage review',
    ],
  },
  {
    id: 'operations_incharge',
    lane: 'operations',
    title: 'Operations Incharge',
    subtitle: 'Daily hospital operations lead',
    role_codes: ['OPERATIONS_INCHARGE', 'GENERAL_STAFF'],
    recommended_role_codes: ['OPERATIONS_INCHARGE'],
    access_level: 'Operations lead access',
    responsibilities: [
      'Coordinates front desk, admissions, bed-flow support, transport, security, and facility escalations',
      'Turns executive policy into daily operational deployment',
    ],
    boundaries: [
      'Work escalation goes to CEO / COO, while leave records go through HR',
      'Does not override clinical admission or ICU allocation rules',
    ],
  },
  {
    id: 'reception_incharge',
    lane: 'operations',
    title: 'Reception / Admission Incharge',
    subtitle: 'Front office lead',
    role_codes: ['RECEPTION_INCHARGE'],
    access_level: 'Front office lead access',
    responsibilities: [
      'Supervises reception, admission counselling, patient intake, and appointment desk coverage',
      'Recommends front-office leave coverage to HR',
    ],
    boundaries: [
      'Cannot see clinical notes beyond role-permitted workflow needs',
    ],
  },
  {
    id: 'reception_team',
    lane: 'operations',
    title: 'Reception Personnel',
    subtitle: 'Front office team',
    role_codes: ['RECEPTIONIST', 'ADMISSION_OFFICER', 'IPD_COUNSELLOR'],
    access_level: 'Front office access',
    responsibilities: [
      'Appointments, patient registration, admission desk support, and front-desk communication',
    ],
    boundaries: [
      'Patient-care decisions remain with clinical staff',
    ],
  },
  {
    id: 'billing_insurance',
    lane: 'operations',
    title: 'Billing / Insurance Desk',
    subtitle: 'Financial clearance and TPA support',
    role_codes: ['BILLING_STAFF', 'INSURANCE_COORDINATOR'],
    access_level: 'Billing and insurance workflow access',
    responsibilities: [
      'Billing queue work, insurance documentation, TPA coordination, and discharge financial clearance',
    ],
    boundaries: [
      'Does not approve clinical discharge or edit clinical documentation',
    ],
  },
  {
    id: 'pharmacy_incharge',
    lane: 'operations',
    title: 'Pharmacy Incharge',
    subtitle: 'Medication supply lead',
    role_codes: ['PHARMACY_INCHARGE'],
    access_level: 'Pharmacy lead access',
    responsibilities: [
      'Supervises pharmacy stock, inpatient dispensing, medication handover, and pharmacy queue completion',
    ],
    boundaries: [
      'Medication order entry remains doctor-controlled unless pharmacy-specific policy grants review-only actions',
    ],
  },
  {
    id: 'pharmacy_staff',
    lane: 'operations',
    title: 'Pharmacy Staff',
    subtitle: 'Dispensing and medication supply team',
    role_codes: ['PHARMACY_STAFF'],
    access_level: 'Pharmacy workflow access',
    responsibilities: [
      'Dispenses inpatient medication requests, updates pharmacy handover status, and flags stock or safety issues',
    ],
    boundaries: [
      'Cannot create or alter doctor medication orders',
    ],
  },
  {
    id: 'housekeeping_incharge',
    lane: 'operations',
    title: 'Housekeeping Incharge',
    subtitle: 'Housekeeping lead',
    role_codes: ['HOUSEKEEPING_INCHARGE'],
    access_level: 'Housekeeping command access',
    responsibilities: [
      'Assigns floor duties, redeploys housekeeping staff, monitors cleaning SLAs, and verifies completion',
      'Coordinates bed-cleaning readiness with nursing and bed management',
    ],
    boundaries: [
      'Can manage housekeeping work, but HR owns leave records and policy approval',
    ],
  },
  {
    id: 'housekeeping_staff',
    lane: 'operations',
    title: 'Housekeeping Staff',
    subtitle: 'Cleaning and turnover team',
    role_codes: ['HOUSEKEEPING_STAFF'],
    access_level: 'Assigned housekeeping task access',
    responsibilities: [
      'Completes assigned cleaning requests, bed turnover tasks, and proof capture',
    ],
    boundaries: [
      'Sees assigned work queues, not appointment queues or clinical records',
    ],
  },
  {
    id: 'maintenance_incharge',
    lane: 'operations',
    title: 'Maintenance Incharge',
    subtitle: 'Facilities and maintenance lead',
    role_codes: ['MAINTENANCE_INCHARGE'],
    recommended_role_codes: ['MAINTENANCE'],
    access_level: 'Maintenance lead access',
    responsibilities: [
      'Assigns maintenance requests, safety-critical repairs, equipment downtime follow-up, and vendor escalation',
    ],
    boundaries: [
      'Maintenance work authority is separate from HR leave processing',
    ],
  },
  {
    id: 'maintenance_team',
    lane: 'operations',
    title: 'Maintenance Personnel',
    subtitle: 'Facilities team',
    role_codes: ['MAINTENANCE'],
    access_level: 'Assigned maintenance task access',
    responsibilities: [
      'Completes assigned electrical, plumbing, equipment, and facility maintenance tasks',
    ],
    boundaries: [
      'Access should be limited to maintenance queues and location metadata',
    ],
  },
  {
    id: 'drivers_security',
    lane: 'operations',
    title: 'Drivers / Security',
    subtitle: 'Transport and safety support',
    role_codes: ['DRIVER', 'AMBULANCE_COORDINATOR', 'SECURITY'],
    access_level: 'Operational support access',
    responsibilities: [
      'Transport duty, ambulance coordination, security desk tasks, and incident support',
    ],
    boundaries: [
      'Leave goes through HR with operational coverage recommendation',
    ],
  },
];

export const ORGANIZATION_HIERARCHY_EDGES = [
  { from: 'ceo_coo', to: 'hr_manager', type: 'governance', label: 'Reports to executive leadership' },
  { from: 'hr_manager', to: 'hr_personnel', type: 'work', label: 'HR work supervision' },
  { from: 'ceo_coo', to: 'medical_superintendent', type: 'governance', label: 'Clinical leadership accountability' },
  { from: 'medical_superintendent', to: 'doctors', type: 'work', label: 'Medical work supervision' },
  { from: 'medical_superintendent', to: 'diagnostics_services', type: 'work', label: 'Diagnostic service governance' },
  { from: 'ceo_coo', to: 'nursing_superintendent', type: 'governance', label: 'Nursing leadership accountability' },
  { from: 'nursing_superintendent', to: 'nursing_incharge', type: 'work', label: 'Nursing work supervision' },
  { from: 'nursing_incharge', to: 'nursing_staff', type: 'work', label: 'Ward and OP nursing deployment' },
  { from: 'ceo_coo', to: 'operations_incharge', type: 'governance', label: 'Operational accountability' },
  { from: 'operations_incharge', to: 'reception_incharge', type: 'work', label: 'Front office supervision' },
  { from: 'reception_incharge', to: 'reception_team', type: 'work', label: 'Front office work allocation' },
  { from: 'operations_incharge', to: 'billing_insurance', type: 'work', label: 'Financial clearance and insurance desk supervision' },
  { from: 'operations_incharge', to: 'pharmacy_incharge', type: 'work', label: 'Pharmacy operations supervision' },
  { from: 'pharmacy_incharge', to: 'pharmacy_staff', type: 'work', label: 'Pharmacy dispensing work allocation' },
  { from: 'operations_incharge', to: 'housekeeping_incharge', type: 'work', label: 'Facility operations supervision' },
  { from: 'housekeeping_incharge', to: 'housekeeping_staff', type: 'work', label: 'Housekeeping floor and task assignment' },
  { from: 'operations_incharge', to: 'maintenance_incharge', type: 'work', label: 'Maintenance escalation and facility work supervision' },
  { from: 'maintenance_incharge', to: 'maintenance_team', type: 'work', label: 'Maintenance task assignment' },
  { from: 'operations_incharge', to: 'drivers_security', type: 'work', label: 'Transport and safety deployment' },
  { from: 'hr_manager', to: 'medical_superintendent', type: 'leave', label: 'Leave records and HR policy process' },
  { from: 'hr_manager', to: 'nursing_superintendent', type: 'leave', label: 'Leave records and HR policy process' },
  { from: 'hr_manager', to: 'operations_incharge', type: 'leave', label: 'Leave records and HR policy process' },
  { from: 'hr_manager', to: 'housekeeping_incharge', type: 'leave', label: 'Leave records only; work line stays operational' },
  { from: 'hr_manager', to: 'maintenance_incharge', type: 'leave', label: 'Leave records only; work line stays operational' },
  { from: 'nursing_incharge', to: 'hr_manager', type: 'leave_recommendation', label: 'Coverage recommendation for nursing leave' },
  { from: 'housekeeping_incharge', to: 'hr_manager', type: 'leave_recommendation', label: 'Coverage recommendation for housekeeping leave' },
  { from: 'maintenance_incharge', to: 'hr_manager', type: 'leave_recommendation', label: 'Coverage recommendation for maintenance leave' },
  { from: 'reception_incharge', to: 'hr_manager', type: 'leave_recommendation', label: 'Coverage recommendation for reception leave' },
];

export const ORGANIZATION_ROLE_BOUNDARIES = [
  {
    title: 'Platform admin access',
    role_codes: ['ADMIN', 'SUPER_ADMIN'],
    scope: 'System configuration, hospital-wide policy, sensitive overrides, and executive escalation.',
    cannot: 'Does not silently replace clinical, nursing, pharmacy, housekeeping, maintenance, or HR approval workflows.',
  },
  {
    title: 'HR process authority',
    role_codes: ['HR_STAFF'],
    scope: 'Leave records, payroll, attendance disputes, onboarding, performance files, and compliance process.',
    cannot: 'Does not assign clinical work, housekeeping floor work, maintenance work, or front-desk daily tasks unless also holding that operational role.',
  },
  {
    title: 'Clinical medical authority',
    role_codes: ['MEDICAL_SUPERINTENDENT', 'CMO', 'DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT'],
    scope: 'Medical care, doctor roster coverage, discharge sign-off, clinical escalation, and medical safety.',
    cannot: 'Does not bypass HR leave recordkeeping or staff payroll controls.',
  },
  {
    title: 'Nursing authority',
    role_codes: ['CNO', 'NURSING_INCHARGE', 'OP_INCHARGE', 'NURSING_STAFF', 'OP_STAFF_NURSE'],
    scope: 'Nursing deployment, nursing documentation, ward coverage, medication administration, and nursing escalation.',
    cannot: 'Does not process payroll or final HR leave records.',
  },
  {
    title: 'Operational authority',
    role_codes: ['RECEPTION_INCHARGE', 'HOUSEKEEPING_INCHARGE', 'MAINTENANCE', 'DRIVER', 'SECURITY'],
    scope: 'Daily work allocation, front-desk coverage, facility task queues, bed-turnover support, transport, and security operations.',
    cannot: 'Does not approve clinical decisions or bypass HR leave approvals.',
  },
];

export const ORGANIZATION_GUARDRAILS = [
  'Keep platform access, work supervision, and HR leave approval as separate dimensions.',
  'For coverage-sensitive leave, require HR process plus functional incharge recommendation.',
  'Executive/Admin overrides must be visible and audit logged.',
  'Clinical sign-off remains with clinical leadership even when CEO / COO has Admin access.',
  'Housekeeping, maintenance, reception, drivers, and security should not inherit appointment or clinical-record access just because they report through operations.',
  'Use dedicated roles later for HR_MANAGER, OPERATIONS_INCHARGE, MAINTENANCE_INCHARGE, and CEO/COO if policy needs separate access from ADMIN.',
];
