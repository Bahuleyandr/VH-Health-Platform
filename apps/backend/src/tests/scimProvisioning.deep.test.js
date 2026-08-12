import crypto from 'crypto';
import { jest } from '@jest/globals';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-ci-must-be-at-least-32-chars';
process.env.SSO_SCIM_MAX_PAGE_SIZE = '2';

const TENANT_A = '10000000-0000-4000-8000-0000000000a1';
const TENANT_B = '10000000-0000-4000-8000-0000000000b1';
const STAFF_UID = '30000000-0000-4000-8000-0000000000a1';
const ADMIN_UID = '40000000-0000-4000-8000-0000000000a1';
const STAFF_PROVIDER_ID = 51n;
const ADMIN_PROVIDER_ID = 61n;
const TOKEN_A = 'scim-token-tenant-a-at-least-20-chars';
const TOKEN_B = 'scim-token-tenant-b-at-least-20-chars';

const setTenantMock = jest.fn();
const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const getTenantBySlug = jest.fn();
const persistRevokeAllUserTokens = jest.fn();
const publishRevokeAllUserTokens = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe },
  setTenant: setTenantMock,
  setTenantTx: setTenantMock,
}));

jest.unstable_mockModule('../services/tenant/tenantService.js', () => ({
  getTenantBySlug,
}));

jest.unstable_mockModule('../utils/tokenBlacklist.js', () => ({
  persistRevokeAllUserTokens,
  publishRevokeAllUserTokens,
}));

jest.unstable_mockModule('../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  getScimUser,
  listScimUsers,
  patchScimUser,
  resolveScimContext,
  serviceProviderConfig,
  upsertScimUser,
} = await import('../services/auth/scimProvisioningService.js');

let scenario;
let uidCounter;

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function provider({ tenantId = TENANT_A, realm = 'staff', token = TOKEN_A } = {}) {
  return {
    id: realm === 'staff' ? STAFF_PROVIDER_ID : ADMIN_PROVIDER_ID,
    tenant_id: tenantId,
    realm,
    protocol: 'oidc',
    provider_key: realm === 'staff' ? 'okta-staff' : 'okta-admin',
    display_name: `Okta ${realm}`,
    status: 'active',
    scim_enabled: true,
    scim_bearer_token_hash: hashToken(token),
    scim_config: {},
  };
}

function tenant(id, slug) {
  return { id, slug, name: slug, status: 'active' };
}

function req(token = TOKEN_A, rawBody = '{}') {
  return {
    id: 'req-scim',
    ip: '127.0.0.1',
    scimRawBody: Buffer.from(rawBody, 'utf8'),
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'jest-scim',
    },
  };
}

function staffRow(overrides = {}) {
  const uid = overrides.uid || STAFF_UID;
  return {
    user: {
      id: overrides.userId || 101,
      uid,
      tenant_id: TENANT_A,
      name: overrides.name || 'Nurse Priya',
      email: overrides.email || 'priya@example.test',
      role: overrides.role || 'NURSING_STAFF',
      is_active: overrides.userActive ?? true,
      status: overrides.userStatus || 'active',
      identity_source: overrides.userSource || 'scim',
      scim_external_id: overrides.externalId || 'ext-priya',
      scim_provider_id: overrides.providerId || STAFF_PROVIDER_ID,
      is_break_glass_account: overrides.breakGlass || false,
      break_glass_name: overrides.breakGlass ? 'Emergency Local Admin' : null,
      created_at: new Date('2026-07-06T00:00:00Z'),
      updated_at: new Date('2026-07-06T00:00:00Z'),
    },
    staff: {
      id: overrides.staffId || 42,
      user_id: uid,
      tenant_id: TENANT_A,
      employee_id: overrides.employeeId || 'EMP-42',
      name: overrides.staffName || overrides.name || 'Nurse Priya',
      department: overrides.department || 'Nursing',
      position: overrides.position || 'RN',
      is_active: overrides.staffActive ?? true,
      archived: overrides.archived || false,
      archived_at: overrides.archivedAt || null,
      identity_source: overrides.staffSource || 'scim',
      scim_external_id: overrides.externalId || 'ext-priya',
      scim_provider_id: overrides.providerId || STAFF_PROVIDER_ID,
      updated_at: new Date('2026-07-06T00:00:00Z'),
    },
  };
}

function staffScimProjection(row) {
  return {
    id: row.user.id,
    uid: row.user.uid,
    name: row.user.name,
    email: row.user.email,
    role: row.user.role,
    user_is_active: row.user.is_active,
    user_status: row.user.status,
    user_identity_source: row.user.identity_source,
    scim_external_id: row.user.scim_external_id,
    is_break_glass_account: row.user.is_break_glass_account,
    break_glass_name: row.user.break_glass_name,
    created_at: row.user.created_at,
    updated_at: row.user.updated_at,
    staff_id: row.staff.id,
    employee_id: row.staff.employee_id,
    staff_name: row.staff.name,
    department: row.staff.department,
    position: row.staff.position,
    staff_is_active: row.staff.is_active,
    archived: row.staff.archived,
    archived_at: row.staff.archived_at,
    staff_identity_source: row.staff.identity_source,
    staff_updated_at: row.staff.updated_at,
  };
}

function adminProjection(row) {
  return {
    uid: row.uid,
    tenant_id: row.tenant_id,
    username: row.username,
    email: row.email,
    name: row.name,
    role: row.role,
    is_active: row.is_active,
    status: row.status,
    identity_source: row.identity_source,
    scim_external_id: row.scim_external_id,
    scim_provider_id: row.scim_provider_id,
    is_break_glass_account: row.is_break_glass_account || false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function resetScenario(overrides = {}) {
  uidCounter = 10;
  scenario = {
    tenants: {
      acme: tenant(TENANT_A, 'acme'),
      beta: tenant(TENANT_B, 'beta'),
    },
    providers: [
      provider({ tenantId: TENANT_A, realm: 'staff', token: TOKEN_A }),
      provider({ tenantId: TENANT_B, realm: 'staff', token: TOKEN_B }),
      provider({ tenantId: TENANT_A, realm: 'admin', token: TOKEN_A }),
    ],
    mappings: [
      { idp_group: 'nursing', vh_role: 'NURSING_STAFF', priority: 10, realm: 'staff', provider_id: STAFF_PROVIDER_ID, tenant_id: TENANT_A, status: 'active' },
      { idp_group: 'admin', vh_role: 'ADMIN', priority: 10, realm: 'admin', provider_id: ADMIN_PROVIDER_ID, tenant_id: TENANT_A, status: 'active' },
    ],
    staffRows: [],
    adminRows: [],
    activeSessions: 3,
    staffAuthSessions: 2,
    staffDevices: 2,
    audits: [],
    commandReceipts: [],
    ...overrides,
  };
}

function nextUid(prefix = '30000000') {
  uidCounter += 1;
  return `${prefix}-0000-4000-8000-${String(uidCounter).padStart(12, '0')}`;
}

function findStaffByUid(uid) {
  return scenario.staffRows.find((row) => row.user.uid === uid);
}

function findStaffByIdentity({ uid, externalId, email, employeeId }) {
  if (uid) return findStaffByUid(uid);
  return scenario.staffRows.find((row) => (
    (externalId && (row.user.scim_external_id === externalId || row.staff.scim_external_id === externalId))
    || (email && row.user.email?.toLowerCase() === email.toLowerCase())
    || (employeeId && row.staff.employee_id === employeeId)
  ));
}

function mappedRows({ providerId, realm, groups, role }) {
  return scenario.mappings
    .filter((row) => row.provider_id === providerId && row.realm === realm && row.status === 'active')
    .filter((row) => {
      if (groups) return groups.includes(String(row.idp_group).toLowerCase());
      if (role) return row.vh_role === role;
      return true;
    })
    .sort((a, b) => a.priority - b.priority || a.idp_group.localeCompare(b.idp_group));
}

function filterStaffRows(params, compact) {
  let rows = scenario.staffRows.filter((row) => (
    row.user.tenant_id === params[0]
    && (row.user.scim_provider_id === params[1] || row.staff.scim_provider_id === params[1])
  ));
  if (compact.includes('lower(u.email) = lower')) {
    rows = rows.filter((row) => row.user.email?.toLowerCase() === String(params[2]).toLowerCase());
  } else if (compact.includes('u.scim_external_id') && params.length > 2) {
    rows = rows.filter((row) => (
      row.user.scim_external_id === params[2]
      || row.staff.scim_external_id === params[2]
      || row.staff.employee_id === params[2]
    ));
  }
  return rows;
}

async function routeQuery(sql, ...params) {
  const compact = sql.replace(/\s+/g, ' ');

  if (compact.includes('INSERT INTO scim_provisioning_commands')) {
    const receipt = {
      id: String(scenario.commandReceipts.length + 1),
      tenantId: params[0],
      providerId: params[1],
      providerKey: params[2],
      realm: params[3],
      commandKind: params[4],
      method: params[5],
      targetUid: params[6],
      externalId: params[7],
      bodySha256: params[11],
      bodyBytes: params[12],
      payloadSha256: params[14],
      payloadBytes: params[15],
      effectDisposition: params[17],
      executionDisposition: params[18],
    };
    scenario.commandReceipts.push(receipt);
    return [{
      id: receipt.id,
      body_sha256: receipt.bodySha256,
      body_bytes: receipt.bodyBytes,
      payload_sha256: receipt.payloadSha256,
      payload_bytes: receipt.payloadBytes,
      execution_disposition: receipt.executionDisposition,
    }];
  }

  if (compact.includes('FROM tenant_identity_providers')) {
    return scenario.providers.filter((row) => (
      row.tenant_id === params[0]
      && row.provider_key === params[1]
      && row.status === 'active'
      && row.scim_enabled === true
    ));
  }

  if (compact.includes('FROM tenant_idp_role_mappings')) {
    if (compact.includes('lower(idp_group) = ANY')) {
      return mappedRows({ providerId: params[1], realm: params[2], groups: params[3] });
    }
    if (compact.includes('vh_role = $4')) {
      return mappedRows({ providerId: params[1], realm: params[2], role: params[3] });
    }
    if (compact.includes('COUNT(*)::int AS count')) {
      return [{ count: mappedRows({ providerId: params[1], realm: params[2] }).length }];
    }
    return mappedRows({ providerId: params[1], realm: params[2] });
  }

  if (compact.includes('FROM user_active_sessions')) return [{ count: scenario.activeSessions }];
  if (compact.includes('FROM staff_auth_sessions')) return [{ count: scenario.staffAuthSessions }];
  if (compact.includes('FROM staff_devices')) return [{ count: scenario.staffDevices }];

  if (compact.includes('FROM users u') && compact.includes('JOIN staff s')) {
    if (compact.includes('COUNT(*)::int AS count')) return [{ count: filterStaffRows(params, compact).length }];
    if (compact.includes('LIMIT $') && compact.includes('OFFSET')) {
      const rows = filterStaffRows(params, compact).map(staffScimProjection);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return rows.slice(offset, offset + limit);
    }
    if (compact.includes('u.uid = $2::uuid')) {
      const found = findStaffByUid(params[1]);
      return found ? [staffScimProjection(found)] : [];
    }
    const found = findStaffByIdentity({
      externalId: params[1],
      email: params[2],
      employeeId: params[3],
    });
    return found ? [{
      id: found.user.id,
      uid: found.user.uid,
      role: found.user.role,
      is_active: found.user.is_active,
      status: found.user.status,
      user_identity_source: found.user.identity_source,
      scim_external_id: found.user.scim_external_id,
      is_break_glass_account: found.user.is_break_glass_account,
      staff_id: found.staff.id,
      staff_is_active: found.staff.is_active,
      archived: found.staff.archived,
      staff_identity_source: found.staff.identity_source,
      staff_external_id: found.staff.scim_external_id,
    }] : [];
  }

  if (compact.includes('INSERT INTO users')) {
    const uid = nextUid();
    const row = staffRow({
      userId: 200 + uidCounter,
      uid,
      name: params[0],
      email: params[1],
      role: params[2],
      userActive: params[3],
      userStatus: params[4],
      externalId: params[7],
      providerId: params[8],
    });
    scenario.pendingStaff = row;
    return [{ id: row.user.id, uid }];
  }

  if (compact.includes('INSERT INTO staff')) {
    const row = scenario.pendingStaff;
    row.staff.id = 300 + uidCounter;
    row.staff.user_id = params[0];
    row.staff.employee_id = params[1];
    row.staff.name = params[2];
    row.staff.department = params[3];
    row.staff.position = params[4];
    row.staff.is_active = params[5];
    row.staff.tenant_id = params[6];
    row.staff.scim_external_id = params[7];
    row.staff.scim_provider_id = params[8];
    scenario.staffRows.push(row);
    scenario.pendingStaff = null;
    return [{ id: row.staff.id }];
  }

  if (compact.includes('FROM admins')) {
    if (compact.includes('COUNT(*)::int AS count')) {
      return [{ count: scenario.adminRows.filter((row) => row.tenant_id === params[0] && row.scim_provider_id === params[1]).length }];
    }
    if (compact.includes('LIMIT $') && compact.includes('OFFSET')) {
      return scenario.adminRows
        .filter((row) => row.tenant_id === params[0] && row.scim_provider_id === params[1])
        .map(adminProjection);
    }
    if (compact.includes('SELECT * FROM admins WHERE uid = $1::uuid')) {
      const found = scenario.adminRows.find((row) => row.uid === params[0] && row.tenant_id === params[1]);
      return found ? [adminProjection(found)] : [];
    }
    if (compact.includes('uid = $2::uuid')) {
      const found = scenario.adminRows.find((row) => row.uid === params[1] && row.tenant_id === params[0]);
      return found ? [adminProjection(found)] : [];
    }
    const found = scenario.adminRows.find((row) => (
      row.tenant_id === params[0]
      && ((params[1] && row.scim_external_id === params[1])
        || (params[2] && row.email?.toLowerCase() === String(params[2]).toLowerCase())
        || (params[3] && row.username?.toLowerCase() === String(params[3]).toLowerCase()))
    ));
    return found ? [adminProjection(found)] : [];
  }

  if (compact.includes('INSERT INTO admins')) {
    const row = {
      uid: ADMIN_UID,
      tenant_id: params[7],
      username: params[0],
      email: params[2],
      name: params[3],
      role: params[4],
      is_active: params[5],
      status: params[6],
      identity_source: 'scim',
      scim_external_id: params[8],
      scim_provider_id: params[9],
      is_break_glass_account: false,
      created_at: new Date('2026-07-06T00:00:00Z'),
      updated_at: new Date('2026-07-06T00:00:00Z'),
    };
    scenario.adminRows.push(row);
    return [adminProjection(row)];
  }

  return [];
}

async function routeExecute(sql, ...params) {
  const compact = sql.replace(/\s+/g, ' ');

  if (compact.includes('INSERT INTO identity_audit_events')) {
    scenario.audits.push({
      realm: params[1],
      providerId: params[2],
      providerKey: params[3],
      eventType: params[4],
      outcome: params[5],
      localUid: params[6],
      details: params[10] ? JSON.parse(params[10]) : {},
    });
    return 1;
  }

  if (compact.includes('UPDATE tenant_identity_providers')) return 1;

  if (compact.includes('DELETE FROM user_active_sessions')) {
    scenario.activeSessions = 0;
    return 1;
  }
  if (compact.includes('DELETE FROM staff_auth_sessions')) {
    scenario.staffAuthSessions = 0;
    return 1;
  }
  if (compact.includes('UPDATE staff_devices')) {
    scenario.staffDevices = 0;
    return 1;
  }

  if (compact.includes('UPDATE users')) {
    const row = findStaffByUid(params[0]);
    if (!row) return 0;
    if (compact.includes('status_reason')) {
      row.user.is_active = false;
      row.user.status = 'inactive';
      return 1;
    }
    row.user.name = params[1] ?? row.user.name;
    row.user.email = params[2] ?? row.user.email;
    row.user.role = params[3] ?? row.user.role;
    if (params[4] === true) {
      row.user.is_active = true;
      row.user.status = 'active';
    }
    row.user.identity_source = params[5];
    row.user.scim_external_id = params[6] ?? row.user.scim_external_id;
    row.user.scim_provider_id = params[7];
    return 1;
  }

  if (compact.includes('UPDATE staff')) {
    const row = scenario.staffRows.find((candidate) => candidate.staff.id === params[0]);
    if (!row) return 0;
    if (compact.includes('archive_reason')) {
      row.staff.is_active = false;
      row.staff.archived = true;
      row.staff.archived_at = new Date('2026-07-06T01:00:00Z');
      return 1;
    }
    row.staff.employee_id = params[1] ?? row.staff.employee_id;
    row.staff.name = params[2] ?? row.staff.name;
    row.staff.department = params[3] ?? row.staff.department;
    row.staff.position = params[4] ?? row.staff.position;
    if (params[5] === true) {
      row.staff.is_active = true;
      row.staff.archived = false;
      row.staff.archived_at = null;
    }
    row.staff.identity_source = params[6];
    row.staff.scim_external_id = params[7] ?? row.staff.scim_external_id;
    row.staff.scim_provider_id = params[8];
    return 1;
  }

  if (compact.includes('UPDATE admins')) {
    const row = scenario.adminRows.find((candidate) => candidate.uid === params[0]);
    if (!row) return 0;
    if (compact.includes('deactivation_reason')) {
      row.is_active = false;
      row.status = 'inactive';
      return 1;
    }
    row.email = params[1] ?? row.email;
    row.name = params[2] ?? row.name;
    row.role = params[3] ?? row.role;
    if (params[4] === true) {
      row.is_active = true;
      row.status = 'active';
    }
    row.identity_source = params[5];
    row.scim_external_id = params[6] ?? row.scim_external_id;
    row.scim_provider_id = params[7];
    return 1;
  }

  return 1;
}

async function staffContext(token = TOKEN_A, tenantSlug = 'acme') {
  return resolveScimContext({ tenantSlug, providerKey: 'okta-staff', req: req(token) });
}

async function adminContext() {
  return resolveScimContext({ tenantSlug: 'acme', providerKey: 'okta-admin', req: req(TOKEN_A) });
}

describe('SCIM 2.0 provisioning service', () => {
  beforeEach(() => {
    resetScenario();
    getTenantBySlug.mockImplementation(async (slug) => scenario.tenants[slug] || null);
    setTenantMock.mockImplementation(async (_tenantId, fn) => fn({
      $queryRawUnsafe: routeQuery,
      $executeRawUnsafe: routeExecute,
    }));
    queryRawUnsafe.mockImplementation(routeQuery);
    executeRawUnsafe.mockImplementation(routeExecute);
    persistRevokeAllUserTokens.mockResolvedValue(1_700_000_000);
    publishRevokeAllUserTokens.mockResolvedValue({ database: { persisted: true } });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('resolves tenant/provider before bearer auth and isolates tenant tokens', async () => {
    await expect(staffContext(TOKEN_A, 'acme')).resolves.toMatchObject({
      tenant: { id: TENANT_A },
      provider: { provider_key: 'okta-staff', realm: 'staff' },
    });

    await expect(staffContext(TOKEN_A, 'beta')).rejects.toMatchObject({
      statusCode: 401,
      code: 'SCIM_TOKEN_INVALID',
    });

    expect(scenario.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'SCIM_AUTH_FAILED', outcome: 'denied' }),
    ]));
  });

  it('creates staff through mapped groups, retries idempotently, and lists by SCIM filters with pagination', async () => {
    const context = await staffContext();
    const payload = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'priya@example.test',
      externalId: 'ext-priya',
      active: true,
      displayName: 'Nurse Priya',
      groups: [
        { value: 'nursing' },
        { value: 'unmapped-idp-group' },
      ],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
        employeeNumber: 'EMP-42',
        department: 'Nursing',
      },
    };

    const created = await upsertScimUser(context, payload, { method: 'post', req: req() });
    expect(created.created).toBe(true);
    expect(created.resource).toMatchObject({
      externalId: 'ext-priya',
      userName: 'priya@example.test',
      active: true,
      userType: 'NURSING_STAFF',
    });
    expect(scenario.commandReceipts[0]).toMatchObject({
      commandKind: 'create',
      method: 'POST',
      targetUid: created.resource.id,
      bodyBytes: 2,
      effectDisposition: 'live_applied',
      executionDisposition: 'applied',
    });

    const retried = await upsertScimUser(context, { ...payload, displayName: 'Priya R.' }, { method: 'post', req: req() });
    expect(retried.created).toBe(false);
    expect(retried.resource.id).toBe(created.resource.id);
    expect(findStaffByUid(created.resource.id).user.name).toBe('Priya R.');

    scenario.staffRows.push(staffRow({
      uid: '30000000-0000-4000-8000-0000000000a2',
      userId: 102,
      staffId: 43,
      name: 'Nurse Mira',
      email: 'mira@example.test',
      employeeId: 'EMP-43',
      externalId: 'ext-mira',
    }));

    const byUserName = await listScimUsers(context, { filter: 'userName eq "priya@example.test"', count: '1' });
    expect(byUserName).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 1,
      itemsPerPage: 1,
    });

    const byExternalId = await listScimUsers(context, { filter: 'externalId eq "ext-mira"', startIndex: '1', count: '1' });
    expect(byExternalId.Resources).toHaveLength(1);
    expect(byExternalId.Resources[0].externalId).toBe('ext-mira');

    expect(scenario.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'SCIM_USER_CREATED',
        details: expect.objectContaining({
          mapped_role: 'NURSING_STAFF',
          unmapped_group_count: 1,
        }),
      }),
      expect.objectContaining({ eventType: 'SCIM_USER_UPDATED' }),
    ]));
  });

  it('deactivates staff, revokes every login path primitive, and is idempotent', async () => {
    scenario.staffRows = [staffRow()];
    const context = await staffContext();

    const result = await patchScimUser(context, STAFF_UID, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, { req: req() });

    expect(result.resource.active).toBe(false);
    expect(findStaffByUid(STAFF_UID).user).toMatchObject({ is_active: false, status: 'inactive' });
    expect(findStaffByUid(STAFF_UID).staff).toMatchObject({ is_active: false, archived: true });
    expect(persistRevokeAllUserTokens).toHaveBeenCalledWith(STAFF_UID, expect.objectContaining({
      reason: 'scim_deprovision',
      notificationTenantId: TENANT_A,
    }));
    expect(scenario.activeSessions).toBe(0);
    expect(scenario.staffAuthSessions).toBe(0);
    expect(scenario.staffDevices).toBe(0);

    await expect(patchScimUser(context, STAFF_UID, {
      Operations: [{ op: 'replace', value: { active: false } }],
    }, { req: req() })).resolves.toMatchObject({
      resource: expect.objectContaining({ active: false }),
    });

    expect(scenario.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'SCIM_USER_DEACTIVATED',
        details: expect.objectContaining({
          active: false,
          deprovision: expect.objectContaining({
            excluded_break_glass: false,
            revoked_sessions: 3,
            deleted_staff_sessions: 2,
            disabled_staff_devices: 2,
          }),
        }),
      }),
    ]));
    expect(scenario.commandReceipts.at(-1)).toMatchObject({
      commandKind: 'deactivate',
      method: 'PATCH',
      targetUid: STAFF_UID,
      executionDisposition: 'applied',
    });
  });

  it('publishes staff deprovision revocation only after the tenant transaction commits', async () => {
    scenario.staffRows = [staffRow()];
    const context = await staffContext();
    let activeTransactions = 0;
    const timeline = [];
    setTenantMock.mockImplementation(async (_tenantId, fn) => {
      activeTransactions += 1;
      timeline.push('transaction:start');
      try {
        const result = await fn({
          $queryRawUnsafe: routeQuery,
          $executeRawUnsafe: routeExecute,
        });
        timeline.push('transaction:commit');
        return result;
      } finally {
        activeTransactions -= 1;
      }
    });
    publishRevokeAllUserTokens.mockImplementationOnce(async () => {
      expect(activeTransactions).toBe(0);
      timeline.push('revocation:publish');
      return { database: { persisted: true } };
    });

    await patchScimUser(context, STAFF_UID, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, { req: req() });

    expect(timeline).toContain('revocation:publish');
    expect(timeline.indexOf('transaction:commit'))
      .toBeLessThan(timeline.indexOf('revocation:publish'));
  });

  it('does not publish staff deprovision revocation when the outer transaction rolls back', async () => {
    scenario.staffRows = [staffRow()];
    const context = await staffContext();
    setTenantMock.mockImplementation(async (_tenantId, fn) => {
      const result = await fn({
        $queryRawUnsafe: routeQuery,
        $executeRawUnsafe: routeExecute,
      });
      if (persistRevokeAllUserTokens.mock.calls.length > 0) {
        throw new Error('simulated commit failure');
      }
      return result;
    });

    await expect(patchScimUser(context, STAFF_UID, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, { req: req() })).rejects.toThrow('simulated commit failure');

    expect(persistRevokeAllUserTokens).toHaveBeenCalledTimes(1);
    expect(publishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('excludes break-glass accounts from SCIM deactivation', async () => {
    scenario.staffRows = [staffRow({ breakGlass: true })];
    const context = await staffContext();

    const result = await patchScimUser(context, STAFF_UID, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, { req: req() });

    expect(result.resource.active).toBe(true);
    expect(findStaffByUid(STAFF_UID).user.is_active).toBe(true);
    expect(persistRevokeAllUserTokens).not.toHaveBeenCalled();
    expect(scenario.commandReceipts.at(-1)).toMatchObject({
      commandKind: 'deactivate',
      effectDisposition: 'live_excluded',
      executionDisposition: 'break_glass_excluded',
    });
    expect(scenario.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'SCIM_USER_DEACTIVATED',
        details: expect.objectContaining({
          deprovision: expect.objectContaining({ excluded_break_glass: true }),
        }),
      }),
    ]));
  });

  it('tracks local/scim/hybrid source ownership transitions without changing local-only app settings', async () => {
    const context = await staffContext();
    scenario.staffRows = [
      staffRow({ uid: STAFF_UID, userSource: 'local', staffSource: 'local', externalId: 'local-ext' }),
      staffRow({
        uid: '30000000-0000-4000-8000-0000000000b2',
        userId: 202,
        staffId: 44,
        userSource: 'scim',
        staffSource: 'scim',
        email: 'scim@example.test',
        employeeId: 'EMP-44',
        externalId: 'scim-ext',
      }),
      staffRow({
        uid: '30000000-0000-4000-8000-0000000000b3',
        userId: 203,
        staffId: 45,
        userSource: 'hybrid',
        staffSource: 'hybrid',
        email: 'hybrid@example.test',
        employeeId: 'EMP-45',
        externalId: 'hybrid-ext',
      }),
    ];

    for (const externalId of ['local-ext', 'scim-ext', 'hybrid-ext']) {
      const current = await getScimUser(context, scenario.staffRows.find((row) => row.user.scim_external_id === externalId).user.uid);
      await upsertScimUser(context, {
        ...current,
        active: true,
        groups: [{ value: 'nursing' }],
      }, { id: current.id, method: 'put', req: req() });
    }

    expect(scenario.staffRows.map((row) => row.user.identity_source)).toEqual(['hybrid', 'scim', 'hybrid']);
    expect(scenario.staffRows.map((row) => row.staff.identity_source)).toEqual(['hybrid', 'scim', 'hybrid']);
  });

  it('supports the admin realm and advertises the SCIM conformance subset', async () => {
    const context = await adminContext();
    const created = await upsertScimUser(context, {
      userName: 'admin@example.test',
      externalId: 'admin-ext',
      displayName: 'Tenant Admin',
      active: true,
      groups: [{ value: 'admin' }],
    }, { method: 'post', req: req() });

    expect(created).toMatchObject({
      created: true,
      resource: {
        id: ADMIN_UID,
        userName: 'admin@example.test',
        active: true,
        userType: 'ADMIN',
      },
    });
    expect(serviceProviderConfig()).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 2 },
      changePassword: { supported: false },
    });
  });

  it('publishes admin deprovision revocation only after the tenant transaction commits', async () => {
    const context = await adminContext();
    await upsertScimUser(context, {
      userName: 'admin@example.test',
      externalId: 'admin-ext',
      displayName: 'Tenant Admin',
      active: true,
      groups: [{ value: 'admin' }],
    }, { method: 'post', req: req() });
    publishRevokeAllUserTokens.mockClear();

    let activeTransactions = 0;
    setTenantMock.mockImplementation(async (_tenantId, fn) => {
      activeTransactions += 1;
      try {
        return await fn({
          $queryRawUnsafe: routeQuery,
          $executeRawUnsafe: routeExecute,
        });
      } finally {
        activeTransactions -= 1;
      }
    });
    publishRevokeAllUserTokens.mockImplementationOnce(async () => {
      expect(activeTransactions).toBe(0);
      return { database: { persisted: true } };
    });

    const result = await patchScimUser(context, ADMIN_UID, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, { req: req() });

    expect(result.resource.active).toBe(false);
    expect(publishRevokeAllUserTokens).toHaveBeenCalledWith(
      ADMIN_UID,
      1_700_000_000,
      { reason: 'scim_deprovision' },
    );
  });
});
