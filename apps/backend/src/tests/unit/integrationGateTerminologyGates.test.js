// src/tests/unit/integrationGateTerminologyGates.test.js
//
// Terminology & knowledge gates on the Integrations & Gates console
// (slate C1 / WP5): terminology_coding, lab_loinc_mapping, drug_kb.
// Pinned invariants:
//   1. Three-layer shape {effective, reason, blocking_layer, layers} — the
//      "provider_config" layer means IMPORTED CONTENT (concepts / licensed
//      source / mapping rows) and every gate ANDs env + tenant + content,
//      fail-closed.
//   2. The blocking layer is named in env → tenant_setting → provider_config
//      order, matching the existing console semantics.
//   3. Env facts stay booleans / enum names (who_icd_configured,
//      terminology_coding_enforcement off|warn|block,
//      drug_kb_deterministic_matching, lab_loinc_mapping_enabled).
//   4. Content checks fail soft: a missing table (sibling migration not
//      merged) or DB error reads as "no content", never as a thrown error.

import { jest } from '@jest/globals';

const resolveGatewayContext = jest.fn();
const listGatewayConfigs = jest.fn();
const isGatewayEnvEnabled = jest.fn();
const resolveSmsProviderContext = jest.fn();
const listSmsProviderConfigs = jest.fn();
const listSmsTemplateRegistrations = jest.fn();
const livekitEnabled = jest.fn();
const listTenants = jest.fn();
const getAbdmEnrolmentSettings = jest.fn();
const getAbdmHiuSettings = jest.fn();
const getAmbulanceGpsTrackingSettings = jest.fn();
const getPaymentGatewaySettings = jest.fn();
const getSmsSettings = jest.fn();
const getUhiSettings = jest.fn();
const getLabLoincMappingSettings = jest.fn();
const getDrugKbSettings = jest.fn();
// Facility-asset gate (facility-asset dark gate): integrationGateService
// imports the accessor by name and the env probe from facilityAssetService,
// so both must exist on the mocks even though these tests never enable them.
const getFacilityAssetsSettings = jest.fn();
const isFacilityAssetsEnvEnabled = jest.fn();
// Embedded-BI accessor (wt/bi-app): integrationGateService imports it by name,
// so the mock module must export it even though these tests never enable it.
const getAnalyticsBiSettings = jest.fn(async () => ({ enabled: false }));
// Reaudit 2026-08-25 forward-slate gate deps (G1/G2/G3/G4). integrationGateService
// imports these env probes + settings accessors by name; the mocks must export
// them even though these terminology-focused tests never enable them.
const isBirthNotificationEnvEnabled = jest.fn(() => false);
const isPublicHealthRegistersEnvEnabled = jest.fn(() => false);
const isGstEInvoiceEnvEnabled = jest.fn(() => false);
const isSiemExportSchedulerEnvEnabled = jest.fn(() => false);
const getBirthNotificationSettings = jest.fn(async () => ({ enabled: false }));
const getPublicHealthRegistersSettings = jest.fn(async () => ({ enabled: false }));
const getGstEInvoiceSettings = jest.fn(async () => ({ enabled: false }));
const getTenantTerminologySettings = jest.fn();
const isWhoIcdConfigured = jest.fn();
const queryRawUnsafe = jest.fn();

const ABDM_CONFIG = {
  enabled: false, environment: 'sandbox', clientId: '', clientSecret: '',
};
const UHI_CONFIG = {
  enabled: false, environment: 'sandbox', subscriberId: '',
  signingPrivateKey: '', signingKeyId: '',
};

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.unstable_mockModule('../../config/abdmConfig.js', () => ({ ABDM_CONFIG }));
jest.unstable_mockModule('../../config/uhiConfig.js', () => ({ UHI_CONFIG }));
jest.unstable_mockModule('../../config/downtimeConfig.js', () => ({
  CLINICAL_CONTINUITY_C_D14_APPROVED: false,
}));
jest.unstable_mockModule('../../config/fileScanPolicy.js', () => ({
  resolveFileScanPolicy: () => 'required',
}));
jest.unstable_mockModule('../../services/billing/paymentGatewayService.js', () => ({
  resolveGatewayContext, listGatewayConfigs, isGatewayEnvEnabled,
}));
jest.unstable_mockModule('../../services/notification/smsProviderConfigService.js', () => ({
  listSmsProviderConfigs, listSmsTemplateRegistrations,
}));
jest.unstable_mockModule('../../utils/notifications/smsProviders/index.js', () => ({
  resolveSmsProviderContext,
}));
jest.unstable_mockModule('../../services/telemedicine/teleconsultProvisioningService.js', () => ({
  livekitEnabled,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  listTenants,
}));
jest.unstable_mockModule('../../services/facility/facilityAssetService.js', () => ({
  isFacilityAssetsEnvEnabled,
}));
jest.unstable_mockModule('../../services/clinical/birthNotificationService.js', () => ({
  isBirthNotificationEnvEnabled,
}));
jest.unstable_mockModule('../../services/publicHealth/publicHealthService.js', () => ({
  isPublicHealthRegistersEnvEnabled,
}));
jest.unstable_mockModule('../../services/billing/gstEInvoiceService.js', () => ({
  isGstEInvoiceEnvEnabled,
}));
jest.unstable_mockModule('../../services/security/siemExportSchedulerService.js', () => ({
  isSiemExportSchedulerEnvEnabled,
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getAbdmEnrolmentSettings,
  getAbdmHiuSettings,
  getAmbulanceGpsTrackingSettings,
  getPaymentGatewaySettings,
  getSmsSettings,
  getUhiSettings,
  // WP3/WP4 accessors — reached via the namespace import's property lookup.
  getLabLoincMappingSettings,
  getDrugKbSettings,
  getAnalyticsBiSettings,
  getFacilityAssetsSettings,
  // Forward-slate accessors (G1/G2/G4).
  getBirthNotificationSettings,
  getPublicHealthRegistersSettings,
  getGstEInvoiceSettings,
}));
jest.unstable_mockModule('../../services/terminology/terminologySettingsService.js', () => ({
  getTenantTerminologySettings,
}));
jest.unstable_mockModule('../../services/terminology/whoIcdClient.js', () => ({
  isWhoIcdConfigured,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  prisma: { $queryRawUnsafe: queryRawUnsafe },
}));

const { listIntegrationGates, integrationGateEnvFacts } =
  await import('../../services/integrations/integrationGateService.js');

const TENANT = {
  id: '33333333-3333-4333-8333-333333333333',
  slug: 'vh-main',
  name: 'VH Main',
  status: 'active',
  settings: {},
};

const GATE_ENV_KEYS = [
  'TERMINOLOGY_CODING_ENFORCEMENT',
  'LAB_LOINC_MAPPING_ENABLED',
  'DRUG_KB_DETERMINISTIC_MATCHING',
  'WHO_ICD_DISABLE_AUTH',
  'WHO_ICD_CLIENT_ID',
  'WHO_ICD_CLIENT_SECRET',
];

// Content counters keyed by the table each COUNT(*) targets.
const contentCounts = {
  terminology_concepts: 0,
  lab_analyzer_code_mappings: 0,
  drug_kb_sources: 0,
};

function primeDefaults() {
  listTenants.mockResolvedValue({ tenants: [TENANT], count: 1 });
  isGatewayEnvEnabled.mockReturnValue(false);
  resolveGatewayContext.mockResolvedValue({
    enabled: false, reason: 'env_disabled', config: null,
  });
  listGatewayConfigs.mockResolvedValue({
    env_enabled: false, tenant_enabled: false, configs: [],
  });
  resolveSmsProviderContext.mockResolvedValue({
    provider: 'dry_run', source: 'env', reason: 'env_kill_switch', config: null,
  });
  listSmsProviderConfigs.mockResolvedValue({
    env_provider: 'logger', env_kill_switch: true, tenant_enabled: false, configs: [],
  });
  listSmsTemplateRegistrations.mockResolvedValue([]);
  livekitEnabled.mockReturnValue(false);
  getAbdmEnrolmentSettings.mockResolvedValue({ enabled: false });
  getAbdmHiuSettings.mockResolvedValue({ enabled: false });
  getAmbulanceGpsTrackingSettings.mockResolvedValue({
    enabled: false, retentionDays: 7, minSecondsBetweenFixes: 3,
  });
  getPaymentGatewaySettings.mockResolvedValue({ enabled: false });
  getSmsSettings.mockResolvedValue({ enabled: false });
  getUhiSettings.mockResolvedValue({ enabled: false, environment: 'sandbox' });
  getFacilityAssetsSettings.mockResolvedValue({ enabled: false });
  isFacilityAssetsEnvEnabled.mockReturnValue(false);
  getLabLoincMappingSettings.mockResolvedValue({ enabled: false });
  getDrugKbSettings.mockResolvedValue({
    deterministicMatching: false, counterSaleAdvisory: false,
  });
  getTenantTerminologySettings.mockResolvedValue({
    preferred_diagnosis_system: 'ICD11',
    enabled_systems: ['ICD10', 'ICD11'],
    snomed_pickers_enabled: false,
  });
  isWhoIcdConfigured.mockReturnValue(false);
  contentCounts.terminology_concepts = 0;
  contentCounts.lab_analyzer_code_mappings = 0;
  contentCounts.drug_kb_sources = 0;
  queryRawUnsafe.mockImplementation(async (sql) => {
    for (const [table, count] of Object.entries(contentCounts)) {
      if (String(sql).includes(table)) return [{ count }];
    }
    return [{ count: 0 }];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of GATE_ENV_KEYS) delete process.env[key];
  primeDefaults();
});

afterAll(() => {
  for (const key of GATE_ENV_KEYS) delete process.env[key];
});

async function gatesFor() {
  const report = await listIntegrationGates();
  return report.tenants[0].gates;
}

describe('terminology_coding gate', () => {
  it('is dark by default with env named as the blocking layer', async () => {
    const gates = await gatesFor();
    expect(gates.terminology_coding).toMatchObject({
      effective: false,
      reason: 'env_enforcement_off',
      blocking_layer: 'env',
      layers: { env: false, tenant_setting: false, provider_config: false },
      env_level: 'off',
    });
  });

  it('treats an unknown TERMINOLOGY_CODING_ENFORCEMENT value as off', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'definitely-on';
    const gates = await gatesFor();
    expect(gates.terminology_coding.env_level).toBe('off');
    expect(gates.terminology_coding.blocking_layer).toBe('env');
  });

  it('env on + all surfaces off blames the tenant flag', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'warn';
    contentCounts.terminology_concepts = 12000;
    const gates = await gatesFor();
    expect(gates.terminology_coding).toMatchObject({
      effective: false,
      reason: 'all_surfaces_off',
      blocking_layer: 'tenant_setting',
      layers: { env: true, tenant_setting: false, provider_config: true },
    });
  });

  it('env + surface on but zero concepts blames content (provider_config)', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'block';
    getTenantTerminologySettings.mockResolvedValue({
      preferred_diagnosis_system: 'ICD10',
      enabled_systems: ['ICD10'],
      snomed_pickers_enabled: false,
      coding_enforcement: { death_certificate: 'warn' },
    });
    const gates = await gatesFor();
    expect(gates.terminology_coding).toMatchObject({
      effective: false,
      reason: 'no_concepts_imported',
      blocking_layer: 'provider_config',
      layers: { env: true, tenant_setting: true, provider_config: false },
      concept_count: 0,
    });
  });

  it('all three layers on → effective, per-surface levels surfaced and normalized', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'warn';
    contentCounts.terminology_concepts = 12000;
    getTenantTerminologySettings.mockResolvedValue({
      preferred_diagnosis_system: 'ICD10',
      enabled_systems: ['ICD10'],
      snomed_pickers_enabled: false,
      coding_enforcement: {
        death_certificate: 'BLOCK', // normalized to lower case
        insurance_claim: 'nonsense', // unknown level → off
      },
    });
    const gates = await gatesFor();
    expect(gates.terminology_coding).toMatchObject({
      effective: true,
      reason: null,
      blocking_layer: null,
      enforcement: {
        death_certificate: 'block',
        insurance_claim: 'off',
        discharge_summary: 'off',
      },
    });
  });

  it('a failing settings read degrades to all-off instead of throwing', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'warn';
    contentCounts.terminology_concepts = 10;
    getTenantTerminologySettings.mockRejectedValue(new Error('rls denied'));
    const gates = await gatesFor();
    expect(gates.terminology_coding).toMatchObject({
      effective: false, blocking_layer: 'tenant_setting',
    });
  });
});

describe('lab_loinc_mapping gate', () => {
  it('requires env AND tenant flag AND active mapping rows', async () => {
    let gates = await gatesFor();
    expect(gates.lab_loinc_mapping).toMatchObject({
      effective: false, reason: 'env_disabled', blocking_layer: 'env',
    });

    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    gates = await gatesFor();
    expect(gates.lab_loinc_mapping).toMatchObject({
      effective: false, reason: 'tenant_disabled', blocking_layer: 'tenant_setting',
    });

    getLabLoincMappingSettings.mockResolvedValue({ enabled: true });
    gates = await gatesFor();
    expect(gates.lab_loinc_mapping).toMatchObject({
      effective: false, reason: 'no_mapping_rows',
      blocking_layer: 'provider_config', mapping_rows: 0,
    });

    contentCounts.lab_analyzer_code_mappings = 42;
    gates = await gatesFor();
    expect(gates.lab_loinc_mapping).toMatchObject({
      effective: true, reason: null, blocking_layer: null, mapping_rows: 42,
      layers: { env: true, tenant_setting: true, provider_config: true },
    });
  });

  it('reads content as absent when the mapping table does not exist yet', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockResolvedValue({ enabled: true });
    queryRawUnsafe.mockRejectedValue(
      new Error('relation "lab_analyzer_code_mappings" does not exist'),
    );
    const gates = await gatesFor();
    expect(gates.lab_loinc_mapping).toMatchObject({
      effective: false, reason: 'no_mapping_rows', blocking_layer: 'provider_config',
    });
  });
});

describe('drug_kb gate', () => {
  it('the starter set alone never satisfies the content layer', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    getDrugKbSettings.mockResolvedValue({
      deterministicMatching: true, counterSaleAdvisory: false,
    });
    // contentCounts.drug_kb_sources stays 0: the SQL counts only
    // is_active AND NOT is_starter rows.
    const gates = await gatesFor();
    expect(gates.drug_kb).toMatchObject({
      effective: false,
      reason: 'no_licensed_source',
      blocking_layer: 'provider_config',
      licensed_active_sources: 0,
    });
  });

  it('env + tenant + licensed active source → effective; advisory flag surfaced', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    getDrugKbSettings.mockResolvedValue({
      deterministicMatching: true, counterSaleAdvisory: true,
    });
    contentCounts.drug_kb_sources = 1;
    const gates = await gatesFor();
    expect(gates.drug_kb).toMatchObject({
      effective: true,
      reason: null,
      blocking_layer: null,
      licensed_active_sources: 1,
      counter_sale_advisory: true,
      layers: { env: true, tenant_setting: true, provider_config: true },
    });
  });

  it('tenant layer blocks when deterministic matching is off even with content', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    contentCounts.drug_kb_sources = 2;
    const gates = await gatesFor();
    expect(gates.drug_kb).toMatchObject({
      effective: false, reason: 'tenant_disabled', blocking_layer: 'tenant_setting',
    });
  });
});

describe('env facts', () => {
  it('exposes the four knowledge facts as booleans / enum names only', () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'WARN';
    isWhoIcdConfigured.mockReturnValue(true);
    const facts = integrationGateEnvFacts();
    expect(facts.who_icd_configured).toBe(true);
    expect(facts.terminology_coding_enforcement).toBe('warn');
    expect(facts.drug_kb_deterministic_matching).toBe(false);
    expect(facts.lab_loinc_mapping_enabled).toBe(false);

    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    const flipped = integrationGateEnvFacts();
    expect(flipped.drug_kb_deterministic_matching).toBe(true);
    expect(flipped.lab_loinc_mapping_enabled).toBe(true);
  });

  it('never leaks WHO ICD credential values', () => {
    process.env.WHO_ICD_CLIENT_ID = 'who-client-id-value';
    process.env.WHO_ICD_CLIENT_SECRET = 'WHO_SECRET_VALUE';
    isWhoIcdConfigured.mockReturnValue(true);
    const serialized = JSON.stringify(integrationGateEnvFacts());
    expect(serialized).not.toContain('who-client-id-value');
    expect(serialized).not.toContain('WHO_SECRET_VALUE');
    expect(JSON.parse(serialized).who_icd_configured).toBe(true);
  });
});
