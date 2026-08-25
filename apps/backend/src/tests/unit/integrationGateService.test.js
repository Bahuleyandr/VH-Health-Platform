// src/tests/unit/integrationGateService.test.js
//
// The Integrations & Gates console assembler. Pinned invariants:
//   1. "effective" comes from each feature's OWN resolver (mocked here),
//      never re-derived — and blocking_layer maps the resolver's reason.
//   2. NO secret material ever appears in the output: resolver config rows
//      (which carry ciphertext columns) are dropped; only the services'
//      write-only admin views (has_* booleans) are surfaced.
//   3. Env facts are booleans/enum names only.

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
const getAnalyticsBiSettings = jest.fn();
const getFacilityAssetsSettings = jest.fn();
const getPaymentGatewaySettings = jest.fn();
const getSmsSettings = jest.fn();
const getUhiSettings = jest.fn();
const isFacilityAssetsEnvEnabled = jest.fn();

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
jest.unstable_mockModule('../../services/facility/facilityAssetService.js', () => ({
  isFacilityAssetsEnvEnabled,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  listTenants,
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getAbdmEnrolmentSettings,
  getAbdmHiuSettings,
  getAmbulanceGpsTrackingSettings,
  getAnalyticsBiSettings,
  getFacilityAssetsSettings,
  getPaymentGatewaySettings,
  getSmsSettings,
  getUhiSettings,
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

// The ciphertext markers a leak would carry.
const KEY_SECRET = 'CIPHERTEXT_KEY_SECRET_v1:deadbeef';
const WEBHOOK_SECRET = 'CIPHERTEXT_WEBHOOK_SECRET_v1:deadbeef';
const AUTH_KEY = 'CIPHERTEXT_AUTH_KEY_v1:deadbeef';

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
  getAnalyticsBiSettings.mockResolvedValue({ enabled: false });
  isFacilityAssetsEnvEnabled.mockReturnValue(false);
  getFacilityAssetsSettings.mockResolvedValue({ enabled: false });
  getPaymentGatewaySettings.mockResolvedValue({ enabled: false });
  getSmsSettings.mockResolvedValue({ enabled: false });
  getUhiSettings.mockResolvedValue({ enabled: false, environment: 'sandbox' });
}

beforeEach(() => {
  jest.clearAllMocks();
  ABDM_CONFIG.enabled = false;
  ABDM_CONFIG.clientId = '';
  ABDM_CONFIG.clientSecret = '';
  UHI_CONFIG.enabled = false;
  delete process.env.METABASE_URL;
  delete process.env.METABASE_EMBED_SECRET;
  delete process.env.DEVICE_GATEWAY_LIS_LISTENERS;
  // Clear every dashboard id so the configured count starts from 0 even if
  // another suite in this worker primed METABASE_DASH_* values.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('METABASE_DASH_')) delete process.env[key];
  }
  primeDefaults();
});

describe('effective-state assembly', () => {
  it('everything dark by default, with the blocking layer named', async () => {
    const report = await listIntegrationGates();
    const gates = report.tenants[0].gates;
    expect(gates.payment_gateway).toMatchObject({
      effective: false, reason: 'env_disabled', blocking_layer: 'env',
    });
    expect(gates.sms).toMatchObject({
      effective: false, provider: 'dry_run', blocking_layer: 'env',
    });
    expect(gates.abdm_enrolment).toMatchObject({ effective: false, blocking_layer: 'env' });
    expect(gates.abdm_scan_share).toMatchObject({
      effective: false, blocking_layer: 'env', rides: 'abdm_enrolment',
    });
    expect(gates.abdm_hiu).toMatchObject({ effective: false, blocking_layer: 'env' });
    expect(gates.uhi).toMatchObject({ effective: false, blocking_layer: 'env' });
    expect(gates.ambulance_gps).toMatchObject({
      effective: false, blocking_layer: 'tenant_setting',
    });
    expect(gates.facility_assets).toMatchObject({
      effective: false, blocking_layer: 'env',
    });
    expect(gates.analytics_bi).toMatchObject({
      effective: false,
      blocking_layer: 'env',
      layers: { env: false, tenant_setting: false },
    });
    expect(gates.lis_listeners).toMatchObject({
      effective: false,
      blocking_layer: 'env',
      reason: 'no_listeners_configured',
      layers: { env: false, provider_config: false },
      listeners_configured: 0,
    });
  });

  it('lis_listeners: env layer parses the listener JSON; analyzers gate the tenant side', async () => {
    // A parseable listener array lights the env layer; with no active
    // interface analyzers the provider_config layer still holds it dark.
    process.env.DEVICE_GATEWAY_LIS_LISTENERS =
      '[{"name": "chem-1", "port": 4001, "protocol": "astm-e1394"}]';
    let report = await listIntegrationGates();
    expect(report.tenants[0].gates.lis_listeners).toMatchObject({
      effective: false,
      blocking_layer: 'provider_config',
      reason: 'no_active_interface_analyzers',
      layers: { env: true, provider_config: false },
      listeners_configured: 1,
    });

    // Set-but-unparseable reads as dark with its own reason, never as open.
    process.env.DEVICE_GATEWAY_LIS_LISTENERS = 'not json';
    report = await listIntegrationGates();
    expect(report.tenants[0].gates.lis_listeners).toMatchObject({
      effective: false,
      blocking_layer: 'env',
      reason: 'listeners_env_invalid',
      listeners_configured: 0,
    });
  });

  it('facility assets: env on + tenant off → tenant_setting; both on → effective', async () => {
    isFacilityAssetsEnvEnabled.mockReturnValue(true);
    let report = await listIntegrationGates();
    expect(report.tenants[0].gates.facility_assets).toMatchObject({
      effective: false,
      blocking_layer: 'tenant_setting',
      layers: { env: true, tenant_setting: false },
    });
    getFacilityAssetsSettings.mockResolvedValue({ enabled: true });
    report = await listIntegrationGates();
    expect(report.tenants[0].gates.facility_assets).toMatchObject({
      effective: true,
      blocking_layer: null,
      layers: { env: true, tenant_setting: true },
    });
  });

  it('analytics_bi: env AND tenant flag; blocking layer names the dark one', async () => {
    // Env configured, tenant flag off → tenant_setting blocks.
    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-secret';
    let report = await listIntegrationGates();
    expect(report.tenants[0].gates.analytics_bi).toMatchObject({
      effective: false,
      blocking_layer: 'tenant_setting',
      layers: { env: true, tenant_setting: false },
    });

    // Both layers on → effective.
    getAnalyticsBiSettings.mockResolvedValue({ enabled: true });
    report = await listIntegrationGates();
    expect(report.tenants[0].gates.analytics_bi).toMatchObject({
      effective: true,
      blocking_layer: null,
      layers: { env: true, tenant_setting: true },
    });

    // Tenant flag on but env dark → env blocks (fail-closed, never wider).
    delete process.env.METABASE_URL;
    delete process.env.METABASE_EMBED_SECRET;
    report = await listIntegrationGates();
    expect(report.tenants[0].gates.analytics_bi).toMatchObject({
      effective: false,
      blocking_layer: 'env',
      layers: { env: false, tenant_setting: true },
    });
  });

  it('env facts surface metabase presence booleans and configured-dashboard count only', async () => {
    expect(integrationGateEnvFacts()).toMatchObject({
      metabase_configured: false,
      metabase_dashboards_configured: 0,
    });

    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-secret';
    process.env.METABASE_DASH_DAILY_OPS = '42';
    process.env.METABASE_DASH_LAB_TAT = '77';
    const facts = integrationGateEnvFacts();
    expect(facts.metabase_configured).toBe(true);
    expect(facts.metabase_dashboards_configured).toBe(2);
    // Never the URL or secret values themselves.
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain('metabase.example.test');
    expect(serialized).not.toContain('unit-test-secret');
  });

  it('env facts surface the LIS listener count, never the listener config', async () => {
    expect(integrationGateEnvFacts()).toMatchObject({ lis_listeners_configured: 0 });
    process.env.DEVICE_GATEWAY_LIS_LISTENERS =
      '[{"name": "chem-1", "host": "10.0.0.5", "port": 4001}, {"name": "haem-1", "port": 4002}]';
    const facts = integrationGateEnvFacts();
    expect(facts.lis_listeners_configured).toBe(2);
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain('chem-1');
    expect(serialized).not.toContain('10.0.0.5');
  });

  it('payment gateway: effective comes from resolveGatewayContext, layers from the admin view', async () => {
    resolveGatewayContext.mockResolvedValue({
      enabled: true,
      reason: null,
      config: { provider: 'razorpay', key_secret_ciphertext: KEY_SECRET },
    });
    listGatewayConfigs.mockResolvedValue({
      env_enabled: true,
      tenant_enabled: true,
      configs: [{
        id: 1, provider: 'razorpay', environment: 'sandbox', enabled: true,
        key_id: 'rzp_test_x', has_key_secret: true, has_webhook_secret: true,
      }],
    });
    getPaymentGatewaySettings.mockResolvedValue({ enabled: true });
    const report = await listIntegrationGates();
    const gate = report.tenants[0].gates.payment_gateway;
    expect(gate.effective).toBe(true);
    expect(gate.blocking_layer).toBeNull();
    expect(gate.layers).toMatchObject({ env: true, tenant_setting: true });
    expect(gate.layers.provider_configs[0]).toMatchObject({
      provider: 'razorpay', has_key_secret: true,
    });
  });

  it('payment gateway: credentials_incomplete blames the provider_config layer', async () => {
    resolveGatewayContext.mockResolvedValue({
      enabled: false, reason: 'credentials_incomplete', config: null,
    });
    const report = await listIntegrationGates();
    expect(report.tenants[0].gates.payment_gateway).toMatchObject({
      effective: false, blocking_layer: 'provider_config',
    });
  });

  it('sms: tenant_disabled blames the tenant flag; a real provider is effective', async () => {
    resolveSmsProviderContext.mockResolvedValue({
      provider: 'dry_run', source: 'default', reason: 'tenant_disabled', config: null,
    });
    let report = await listIntegrationGates();
    expect(report.tenants[0].gates.sms).toMatchObject({
      effective: false, blocking_layer: 'tenant_setting',
    });

    resolveSmsProviderContext.mockResolvedValue({
      provider: 'msg91', source: 'tenant_config', reason: null,
      config: { provider: 'msg91', auth_key_ciphertext: AUTH_KEY },
    });
    listSmsTemplateRegistrations.mockResolvedValue([
      { id: 1, active: true }, { id: 2, active: false },
    ]);
    getSmsSettings.mockResolvedValue({ enabled: true });
    listSmsProviderConfigs.mockResolvedValue({
      env_provider: 'msg91', env_kill_switch: false, tenant_enabled: true,
      configs: [{ id: 1, provider: 'msg91', enabled: true, has_auth_key: true }],
    });
    report = await listIntegrationGates();
    expect(report.tenants[0].gates.sms).toMatchObject({
      effective: true, provider: 'msg91', blocking_layer: null,
      dlt_templates: { total: 2, active: 1 },
    });
  });

  it('abdm: env on + tenant off → tenant_setting; both on → effective, scan&share rides', async () => {
    ABDM_CONFIG.enabled = true;
    let report = await listIntegrationGates();
    expect(report.tenants[0].gates.abdm_enrolment).toMatchObject({
      effective: false, blocking_layer: 'tenant_setting',
    });
    getAbdmEnrolmentSettings.mockResolvedValue({ enabled: true });
    report = await listIntegrationGates();
    expect(report.tenants[0].gates.abdm_enrolment.effective).toBe(true);
    expect(report.tenants[0].gates.abdm_scan_share.effective).toBe(true);
    // HIU keeps its own flag.
    expect(report.tenants[0].gates.abdm_hiu).toMatchObject({
      effective: false, blocking_layer: 'tenant_setting',
    });
  });

  it('filters to a single tenant when tenantId is passed', async () => {
    const other = { ...TENANT, id: '44444444-4444-4444-8444-444444444444', slug: 'other' };
    listTenants.mockResolvedValue({ tenants: [TENANT, other], count: 2 });
    const report = await listIntegrationGates({ tenantId: other.id });
    expect(report.tenants).toHaveLength(1);
    expect(report.tenants[0].tenant.slug).toBe('other');
  });
});

describe('no secret leakage', () => {
  it('never serializes resolver config rows or any ciphertext/env credential', async () => {
    process.env.SMS_PROVIDER = 'msg91';
    process.env.MSG91_AUTH_KEY = 'ENV_MSG91_AUTH_KEY_SECRET';
    ABDM_CONFIG.enabled = true;
    ABDM_CONFIG.clientId = 'abdm-client-id-value';
    ABDM_CONFIG.clientSecret = 'ABDM_CLIENT_SECRET_VALUE';
    resolveGatewayContext.mockResolvedValue({
      enabled: true,
      reason: null,
      config: {
        provider: 'razorpay',
        key_secret_ciphertext: KEY_SECRET,
        webhook_secret_ciphertext: WEBHOOK_SECRET,
      },
    });
    resolveSmsProviderContext.mockResolvedValue({
      provider: 'msg91', source: 'tenant_config', reason: null,
      config: { provider: 'msg91', auth_key_ciphertext: AUTH_KEY },
    });
    try {
      const serialized = JSON.stringify(await listIntegrationGates());
      for (const marker of [
        KEY_SECRET, WEBHOOK_SECRET, AUTH_KEY,
        'ENV_MSG91_AUTH_KEY_SECRET', 'ABDM_CLIENT_SECRET_VALUE',
        'ciphertext',
      ]) {
        expect(serialized).not.toContain(marker);
      }
      // Presence booleans ARE there.
      const facts = JSON.parse(serialized).env;
      expect(facts.abdm_has_client_credentials).toBe(true);
      expect(facts.sms_provider).toBe('msg91');
    } finally {
      delete process.env.SMS_PROVIDER;
      delete process.env.MSG91_AUTH_KEY;
    }
  });

  it('env facts expose only booleans, enum names, and counts', () => {
    const facts = integrationGateEnvFacts();
    for (const [key, value] of Object.entries(facts)) {
      expect(['boolean', 'string', 'object', 'number']).toContain(typeof value);
      if (typeof value === 'string') {
        expect([
          'sms_provider', 'abdm_environment', 'uhi_environment', 'file_scan_policy',
          // Terminology & knowledge (slate C1): enum name off|warn|block.
          'terminology_coding_enforcement',
        ]).toContain(key);
      }
      if (typeof value === 'number') {
        expect([
          'metabase_dashboards_configured',
          // Device-gateway LIS ingress (#891 deferral): listener count only.
          'lis_listeners_configured',
        ]).toContain(key);
      }
    }
  });
});
