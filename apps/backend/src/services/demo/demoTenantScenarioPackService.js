import crypto from 'crypto';

export const DEMO_SCENARIO_PACK_VERSION = 'nl11-s06-p1.v1';
export const DEMO_SEED_TAG = 'nl11_s06_demo_tenant_p1';
export const DEFAULT_DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_DEMO_TENANT_SLUG = 'vh-demo';
export const DEFAULT_DEMO_SCENARIO_DATE = '2026-07-07';

const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOCAL_DEMO_DATABASES = new Set([
  'vhhealth',
  'vhhealth_test',
  'vh_health_test',
  'vhhealth_demo',
]);

function cleanSlug(value, fallback = DEFAULT_DEMO_TENANT_SLUG) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function cleanSeed(value) {
  const cleaned = String(value || '').trim();
  return cleaned || 'nl11-s06-demo-pack';
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value, length = 16) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, length);
}

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

export function parseDatabaseContext(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL or TEST_DATABASE_URL is required for demo-tenant generation.');
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not parseable; refusing demo-tenant generation.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  return {
    host: normalizeHost(parsed.hostname),
    port: parsed.port || null,
    database,
    user: decodeURIComponent(parsed.username || ''),
  };
}

export function assertLocalOnlyDatabaseUrl(connectionString) {
  const context = parseDatabaseContext(connectionString);
  if (!LOCAL_DATABASE_HOSTS.has(context.host)) {
    throw new Error(
      `Refusing demo-tenant generation against non-local database (${context.host}/${context.database}).`
    );
  }
  if (!LOCAL_DEMO_DATABASES.has(context.database)) {
    throw new Error(
      `Refusing demo-tenant generation against unexpected local database (${context.database}).`
    );
  }
  return { ...context, localOnly: true };
}

function buildPersonas() {
  const loginEnvRef = 'VH_DEMO_TENANT_PASSWORD';
  return [
    {
      key: 'platform_admin',
      displayName: 'Synthetic Demo Platform Admin',
      role: 'SUPER_ADMIN',
      employeeId: 'DEMO-470-ADMIN',
      department: 'Administration',
      login: {
        identifier: 'demo.platform.admin@example.invalid',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/admin/login',
      },
      journeys: ['sales_command_center', 'tenant_reset_readiness'],
    },
    {
      key: 'front_desk',
      displayName: 'Synthetic Demo Front Desk',
      role: 'RECEPTIONIST',
      employeeId: 'DEMO-470-FD',
      department: 'Front Office',
      login: {
        identifier: 'DEMO-470-FD',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['ed_chest_pain_acs', 'billing_settlement'],
    },
    {
      key: 'ed_physician',
      displayName: 'Synthetic Demo ED Physician',
      role: 'DOCTOR',
      employeeId: 'DEMO-470-ED',
      department: 'Emergency',
      login: {
        identifier: 'DEMO-470-ED',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['ed_chest_pain_acs', 'dengue_warning_monitoring'],
    },
    {
      key: 'ward_nurse',
      displayName: 'Synthetic Demo Ward Nurse',
      role: 'NURSE',
      employeeId: 'DEMO-470-RN',
      department: 'Inpatient Ward',
      login: {
        identifier: 'DEMO-470-RN',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['post_op_discharge_hub', 'dengue_warning_monitoring'],
    },
    {
      key: 'lab_technician',
      displayName: 'Synthetic Demo Lab Technician',
      role: 'LAB_TECHNICIAN',
      employeeId: 'DEMO-470-LAB',
      department: 'Laboratory',
      login: {
        identifier: 'DEMO-470-LAB',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['lab_radiology_followup'],
    },
    {
      key: 'radiology_technician',
      displayName: 'Synthetic Demo Radiology Technician',
      role: 'RADIOLOGY_TECHNICIAN',
      employeeId: 'DEMO-470-RAD',
      department: 'Radiology',
      login: {
        identifier: 'DEMO-470-RAD',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['lab_radiology_followup'],
    },
    {
      key: 'billing_manager',
      displayName: 'Synthetic Demo Billing Manager',
      role: 'BILLING_MANAGER',
      employeeId: 'DEMO-470-BILL',
      department: 'Billing',
      login: {
        identifier: 'DEMO-470-BILL',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['billing_settlement', 'insurance_cashless_claim'],
    },
    {
      key: 'insurance_coordinator',
      displayName: 'Synthetic Demo Insurance Coordinator',
      role: 'INSURANCE_COORDINATOR',
      employeeId: 'DEMO-470-TPA',
      department: 'Insurance Desk',
      login: {
        identifier: 'DEMO-470-TPA',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['insurance_cashless_claim'],
    },
    {
      key: 'maternity_consultant',
      displayName: 'Synthetic Demo Maternity Consultant',
      role: 'DOCTOR',
      employeeId: 'DEMO-470-OB',
      department: 'Obstetrics',
      login: {
        identifier: 'DEMO-470-OB',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['maternity_antenatal_to_plan'],
    },
    {
      key: 'pharmacist',
      displayName: 'Synthetic Demo Pharmacist',
      role: 'PHARMACIST',
      employeeId: 'DEMO-470-PHARM',
      department: 'Pharmacy',
      login: {
        identifier: 'DEMO-470-PHARM',
        passwordRef: loginEnvRef,
        smokePath: '/api/v1/auth/staff/login',
      },
      journeys: ['post_op_discharge_hub', 'billing_settlement'],
    },
  ];
}

function buildPatients() {
  return [
    {
      key: 'ed_chest_pain',
      displayName: 'Synthetic Demo Asha Cardiac',
      hospitalNumber: 'DEMO-470-001',
      phone: '+919900000401',
      gender: 'female',
      birthYear: 1972,
      carePath: 'ED chest-pain rule-out with cardiology escalation',
      narrative: '[synthetic] Chest discomfort, serial troponin checks, ECG review, and monitored observation.',
      tags: ['ed', 'cardiology', 'lab', 'billing'],
    },
    {
      key: 'maternity_review',
      displayName: 'Synthetic Demo Nila Maternity',
      hospitalNumber: 'DEMO-470-002',
      phone: '+919900000402',
      gender: 'female',
      birthYear: 1994,
      carePath: 'Antenatal review with ultrasound and delivery-plan counselling',
      narrative: '[synthetic] Routine antenatal review, fetal growth ultrasound, counselling, and follow-up plan.',
      tags: ['maternity', 'radiology', 'patient-portal'],
    },
    {
      key: 'post_op_discharge',
      displayName: 'Synthetic Demo Meera Surgery',
      hospitalNumber: 'DEMO-470-003',
      phone: '+919900000403',
      gender: 'female',
      birthYear: 1968,
      carePath: 'Post-operative inpatient recovery through discharge hub',
      narrative: '[synthetic] Post-op day one review, nursing vitals, pharmacy handover, billing clearance, and discharge summary.',
      tags: ['ot', 'ward', 'pharmacy', 'discharge'],
    },
    {
      key: 'pediatric_dengue',
      displayName: 'Synthetic Demo Kabir Paediatric',
      hospitalNumber: 'DEMO-470-004',
      phone: '+919900000404',
      gender: 'male',
      birthYear: 2016,
      carePath: 'Dengue warning-sign monitoring with paediatric escalation',
      narrative: '[synthetic] Fever follow-up, platelet trend review, hydration guidance, and warning-sign checklist.',
      tags: ['paediatric', 'lab', 'nursing'],
    },
    {
      key: 'insurance_cashless',
      displayName: 'Synthetic Demo Rohan Insured',
      hospitalNumber: 'DEMO-470-005',
      phone: '+919900000405',
      gender: 'male',
      birthYear: 1983,
      carePath: 'Cashless insurance preauth, query response, and final claim packet',
      narrative: '[synthetic] Insurance desk prepares preauth, responds to payer query, and assembles claim evidence.',
      tags: ['insurance', 'billing', 'documents'],
    },
    {
      key: 'diagnostic_followup',
      displayName: 'Synthetic Demo Tara Diagnostics',
      hospitalNumber: 'DEMO-470-006',
      phone: '+919900000406',
      gender: 'female',
      birthYear: 1959,
      carePath: 'Lab and radiology result follow-up with clinician acknowledgement',
      narrative: '[synthetic] Abnormal result routing, radiology report acknowledgement, and clinician follow-up task.',
      tags: ['lab', 'radiology', 'clinical-inbox'],
    },
  ];
}

function buildJourneys() {
  return [
    {
      key: 'ed_chest_pain_acs',
      title: 'ED chest-pain to cardiology handoff',
      patientKey: 'ed_chest_pain',
      personaKeys: ['front_desk', 'ed_physician', 'lab_technician', 'billing_manager'],
      salesStory: 'Shows triage speed, order visibility, abnormal-result escalation, and transparent billing readiness.',
      generatedRecords: [
        'front_desk_registration',
        'ed_triage_note',
        'ecg_order',
        'troponin_lab_order',
        'cardiology_review_task',
        'initial_billing_estimate',
      ],
      tourAnchorKeys: ['staff-ed-triage', 'staff-clinical-inbox', 'admin-billing-workbench'],
    },
    {
      key: 'maternity_antenatal_to_plan',
      title: 'Maternity antenatal review to delivery plan',
      patientKey: 'maternity_review',
      personaKeys: ['maternity_consultant', 'radiology_technician'],
      salesStory: 'Shows continuity from outpatient review through ultrasound, counselling, and patient-visible follow-up.',
      generatedRecords: [
        'antenatal_opd_note',
        'fetal_growth_ultrasound_order',
        'radiology_report',
        'delivery_plan_counselling',
        'patient_portal_followup_task',
      ],
      tourAnchorKeys: ['staff-maternity-overview', 'staff-radiology-worklist', 'patient-followup'],
    },
    {
      key: 'post_op_discharge_hub',
      title: 'Post-op ward recovery through discharge hub',
      patientKey: 'post_op_discharge',
      personaKeys: ['ward_nurse', 'pharmacist', 'billing_manager', 'ed_physician'],
      salesStory: 'Shows OT handoff, nursing observations, pharmacy readiness, billing clearance, and doctor-signed discharge.',
      generatedRecords: [
        'ot_procedure_summary',
        'ward_vitals_series',
        'pharmacy_handover',
        'billing_clearance_task',
        'doctor_signed_discharge_summary',
      ],
      tourAnchorKeys: ['staff-bed-board', 'staff-discharge-hub', 'staff-pharmacy-handover'],
    },
    {
      key: 'dengue_warning_monitoring',
      title: 'Paediatric dengue warning-sign monitoring',
      patientKey: 'pediatric_dengue',
      personaKeys: ['ed_physician', 'ward_nurse', 'lab_technician'],
      salesStory: 'Shows trend-based safety monitoring without claiming real AI or real patient data.',
      generatedRecords: [
        'paediatric_assessment',
        'platelet_trend_labs',
        'hydration_nursing_checklist',
        'warning_sign_parent_instruction',
      ],
      tourAnchorKeys: ['staff-vitals-trends', 'staff-lab-worklist', 'patient-instructions'],
    },
    {
      key: 'insurance_cashless_claim',
      title: 'Cashless insurance preauth to claim packet',
      patientKey: 'insurance_cashless',
      personaKeys: ['insurance_coordinator', 'billing_manager'],
      salesStory: 'Shows payer query handling, document completeness, package visibility, and final claim evidence.',
      generatedRecords: [
        'insurance_policy_snapshot',
        'preauth_request',
        'payer_query_response',
        'claim_packet_checklist',
        'final_invoice_summary',
      ],
      tourAnchorKeys: ['admin-insurance-workbench', 'admin-billing-workbench'],
    },
    {
      key: 'lab_radiology_followup',
      title: 'Diagnostics follow-up with clinical acknowledgement',
      patientKey: 'diagnostic_followup',
      personaKeys: ['lab_technician', 'radiology_technician', 'ed_physician'],
      salesStory: 'Shows diagnostics closure, clinician acknowledgement, and traceable follow-up.',
      generatedRecords: [
        'lab_result_panel',
        'radiology_report',
        'abnormal_result_alert',
        'clinician_acknowledgement',
        'followup_appointment',
      ],
      tourAnchorKeys: ['staff-lab-worklist', 'staff-radiology-worklist', 'staff-clinical-inbox'],
    },
    {
      key: 'billing_settlement',
      title: 'Package estimate to settlement',
      patientKey: 'post_op_discharge',
      personaKeys: ['billing_manager', 'front_desk', 'pharmacist'],
      salesStory: 'Shows buyer-facing revenue workflow: estimates, package lines, pharmacy handover, and settlement state.',
      generatedRecords: [
        'package_estimate',
        'pharmacy_charge_handover',
        'deposit_receipt',
        'final_settlement',
      ],
      tourAnchorKeys: ['admin-billing-workbench', 'staff-pharmacy-handover'],
    },
  ];
}

function buildTourAnchors() {
  return [
    {
      key: 'staff-ed-triage',
      client: 'staff',
      route: '/emr/command-center?anchor=demo-ed-triage',
      anchorId: 'demo-ed-triage',
      label: 'ED triage and first orders',
    },
    {
      key: 'staff-clinical-inbox',
      client: 'staff',
      route: '/clinical-inbox?anchor=demo-critical-followup',
      anchorId: 'demo-critical-followup',
      label: 'Critical follow-up task',
    },
    {
      key: 'staff-maternity-overview',
      client: 'staff',
      route: '/maternity?anchor=demo-antenatal-plan',
      anchorId: 'demo-antenatal-plan',
      label: 'Antenatal plan',
    },
    {
      key: 'staff-radiology-worklist',
      client: 'staff',
      route: '/radiology?anchor=demo-radiology-report',
      anchorId: 'demo-radiology-report',
      label: 'Radiology report closure',
    },
    {
      key: 'staff-bed-board',
      client: 'staff',
      route: '/ipd/bed-board?anchor=demo-post-op-bed',
      anchorId: 'demo-post-op-bed',
      label: 'Post-op bed-board state',
    },
    {
      key: 'staff-discharge-hub',
      client: 'staff',
      route: '/discharge-hub?anchor=demo-discharge-checklist',
      anchorId: 'demo-discharge-checklist',
      label: 'Discharge checklist',
    },
    {
      key: 'staff-pharmacy-handover',
      client: 'staff',
      route: '/pharmacy/ward-handover?anchor=demo-discharge-meds',
      anchorId: 'demo-discharge-meds',
      label: 'Discharge medication handover',
    },
    {
      key: 'staff-vitals-trends',
      client: 'staff',
      route: '/emr/vitals?anchor=demo-vitals-trend',
      anchorId: 'demo-vitals-trend',
      label: 'Vitals trend review',
    },
    {
      key: 'staff-lab-worklist',
      client: 'staff',
      route: '/lab?anchor=demo-lab-result',
      anchorId: 'demo-lab-result',
      label: 'Lab result worklist',
    },
    {
      key: 'admin-billing-workbench',
      client: 'admin',
      route: '/dashboard/billing?anchor=demo-billing-ledger',
      anchorId: 'demo-billing-ledger',
      label: 'Billing ledger and settlement',
    },
    {
      key: 'admin-insurance-workbench',
      client: 'admin',
      route: '/dashboard/insurance?anchor=demo-cashless-claim',
      anchorId: 'demo-cashless-claim',
      label: 'Cashless claim packet',
    },
    {
      key: 'patient-followup',
      client: 'patient',
      route: '/appointments?anchor=demo-followup-plan',
      anchorId: 'demo-followup-plan',
      label: 'Follow-up plan',
    },
    {
      key: 'patient-instructions',
      client: 'patient',
      route: '/records?anchor=demo-care-instructions',
      anchorId: 'demo-care-instructions',
      label: 'Patient care instructions',
    },
  ];
}

function buildSafeResetPlan({ tenantSlug }) {
  return {
    mode: 'local_only_seed_tagged_reset',
    seedTag: DEMO_SEED_TAG,
    tenantSlug,
    preflight: [
      'Assert DATABASE_URL host is loopback before any write.',
      'Print dry-run counts for every selector before deleting or rebuilding demo rows.',
      'Abort if a selector would match a row missing the demo seed tag or DEMO-470 prefix.',
    ],
    selectors: [
      {
        scope: 'patients',
        match: 'hospital_number starts with DEMO-470- and metadata.source equals nl11_s06_demo_tenant_p1',
      },
      {
        scope: 'staff_personas',
        match: 'employee_id starts with DEMO-470- and email domain is example.invalid',
      },
      {
        scope: 'journey_records',
        match: 'idempotency_key starts with nl11_s06_demo_tenant_p1:',
      },
      {
        scope: 'tour_anchors',
        match: 'anchor_id starts with demo- and source equals nl11_s06_demo_tenant_p1',
      },
    ],
    preserves: [
      'Any row without the exact seed tag.',
      'Any non-loopback database.',
      'Any production-like host, even when a tenant slug looks like a demo tenant.',
    ],
  };
}

function buildLedgerEntries(pack, packFingerprint) {
  const entries = [];
  let sequence = 1;
  const push = (kind, key, summary, count = 1) => {
    entries.push({
      sequence,
      kind,
      key,
      summary,
      count,
      fingerprint: fingerprint({ packFingerprint, sequence, kind, key, summary, count }, 12),
    });
    sequence += 1;
  };

  for (const persona of pack.personas) {
    push('persona', persona.key, `${persona.role} login ${persona.login.identifier}`);
  }
  for (const patient of pack.patients) {
    push('patient', patient.key, `${patient.hospitalNumber} ${patient.carePath}`);
  }
  for (const journey of pack.journeys) {
    push('journey', journey.key, journey.title, journey.generatedRecords.length);
  }
  for (const anchor of pack.tourAnchors) {
    push('tour_anchor', anchor.key, `${anchor.client} ${anchor.route}`);
  }
  push('safe_reset', 'local-only', 'Seed-tagged reset plan; no non-local override exists.', pack.safeReset.selectors.length);
  return entries;
}

function collectStrings(value, path = '$', out = []) {
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

function isAllowedDemoEmail(email) {
  return /@(example\.invalid|example\.com)$/i.test(email);
}

function isAllowedDemoPhone(match) {
  let digits = String(match).replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  return /^99000004\d{2}$/.test(digits);
}

function isUuidText(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function addFinding(findings, code, path, value) {
  findings.push({
    code,
    path,
    sample: String(value).slice(0, 96),
  });
}

function isDeterministicHashPath(path) {
  return /\.(?:fingerprint|packFingerprint|finalFingerprint|replayKey)$/i.test(path);
}

export function scanDemoPackForPhi(pack) {
  const findings = [];
  const strings = collectStrings(pack);
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const phonePattern = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g;
  const hospitalIdPattern = /\b(?:MRN|UHID|VH)[-:\s]?\d{4,}\b/gi;
  const aadhaarPattern = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
  const panPattern = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

  for (const { path, value } of strings) {
    if (isDeterministicHashPath(path)) continue;
    for (const email of value.match(emailPattern) || []) {
      if (!isAllowedDemoEmail(email)) addFinding(findings, 'EMAIL_DETECTED', path, email);
    }
    for (const phone of value.match(phonePattern) || []) {
      if (!isAllowedDemoPhone(phone)) addFinding(findings, 'PHONE_DETECTED', path, phone);
    }
    for (const hospitalId of value.match(hospitalIdPattern) || []) {
      addFinding(findings, 'REAL_HOSPITAL_ID_PATTERN', path, hospitalId);
    }
    for (const aadhaar of value.match(aadhaarPattern) || []) {
      if (isUuidText(value) || isAllowedDemoPhone(aadhaar)) continue;
      addFinding(findings, 'AADHAAR_LIKE_IDENTIFIER', path, aadhaar);
    }
    for (const pan of value.match(panPattern) || []) {
      addFinding(findings, 'PAN_LIKE_IDENTIFIER', path, pan);
    }
  }

  for (const patient of pack?.patients || []) {
    if (!String(patient.displayName || '').startsWith('Synthetic Demo ')) {
      addFinding(findings, 'PATIENT_NAME_NOT_SYNTHETIC', `$.patients.${patient.key}.displayName`, patient.displayName);
    }
    if (!String(patient.narrative || '').startsWith('[synthetic]')) {
      addFinding(findings, 'NARRATIVE_NOT_SYNTHETIC', `$.patients.${patient.key}.narrative`, patient.narrative);
    }
  }

  return findings;
}

export function assertDemoPackHasNoPhi(pack) {
  const findings = scanDemoPackForPhi(pack);
  if (findings.length) {
    const sample = findings.slice(0, 3).map((finding) => `${finding.code} at ${finding.path}`).join('; ');
    throw new Error(`Demo scenario pack failed no-PHI scan: ${sample}`);
  }
  return true;
}

export function buildGeneratedLoginSmoke(pack) {
  const failures = [];
  for (const persona of pack.personas || []) {
    if (!persona.login?.identifier) failures.push(`${persona.key}: missing login identifier`);
    if (!persona.login?.passwordRef) failures.push(`${persona.key}: missing password reference`);
    if (!persona.login?.smokePath) failures.push(`${persona.key}: missing login smoke path`);
    if (!Array.isArray(persona.journeys) || persona.journeys.length === 0) {
      failures.push(`${persona.key}: missing journey assignment`);
    }
  }
  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    checkedPersonas: pack.personas?.length || 0,
    failures,
  };
}

export function buildDemoTenantScenarioPack(options = {}) {
  const scenarioDate = String(options.scenarioDate || DEFAULT_DEMO_SCENARIO_DATE);
  const seed = cleanSeed(options.seed);
  const tenantSlug = cleanSlug(options.tenantSlug);
  const tenantId = String(options.tenantId || DEFAULT_DEMO_TENANT_ID);
  const packId = cleanSlug(options.packId || 'sales-core', 'sales-core');
  const personas = buildPersonas();
  const patients = buildPatients();
  const journeys = buildJourneys();
  const tourAnchors = buildTourAnchors();
  const safeReset = buildSafeResetPlan({ tenantSlug });
  const basePack = {
    schemaVersion: DEMO_SCENARIO_PACK_VERSION,
    packId,
    seedTag: DEMO_SEED_TAG,
    generatedAt: `${scenarioDate}T00:00:00.000Z`,
    tenant: {
      id: tenantId,
      slug: tenantSlug,
      displayName: options.tenantName || 'VH Health Synthetic Demo Hospital',
    },
    determinism: {
      seed,
      scenarioDate,
      replayKey: fingerprint({ packId, seed, scenarioDate, tenantSlug, tenantId }, 24),
    },
    localOnly: {
      guard: 'DATABASE_URL or TEST_DATABASE_URL must resolve to loopback before stateful generation.',
      allowedHosts: [...LOCAL_DATABASE_HOSTS].sort(),
      allowedDatabases: [...LOCAL_DEMO_DATABASES].sort(),
      nonLocalOverride: 'none',
    },
    personas,
    patients,
    journeys,
    tourAnchors,
    safeReset,
  };
  const packFingerprint = fingerprint(basePack, 24);
  const pack = compactObject({
    ...basePack,
    packFingerprint,
    generatedLoginSmoke: buildGeneratedLoginSmoke(basePack),
    buildLedger: buildLedgerEntries(basePack, packFingerprint),
    contentSafety: {
      scanner: 'demo-pack-no-phi-v1',
      status: 'pass',
      findings: [],
    },
  });
  assertDemoPackHasNoPhi(pack);
  return {
    ...pack,
    finalFingerprint: fingerprint(pack, 24),
  };
}

export default {
  DEMO_SCENARIO_PACK_VERSION,
  DEMO_SEED_TAG,
  DEFAULT_DEMO_TENANT_ID,
  DEFAULT_DEMO_TENANT_SLUG,
  DEFAULT_DEMO_SCENARIO_DATE,
  assertLocalOnlyDatabaseUrl,
  parseDatabaseContext,
  buildDemoTenantScenarioPack,
  buildGeneratedLoginSmoke,
  scanDemoPackForPhi,
  assertDemoPackHasNoPhi,
  stableStringify,
  fingerprint,
};
