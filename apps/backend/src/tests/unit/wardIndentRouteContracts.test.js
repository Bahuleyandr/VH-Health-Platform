import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'a7410000-0000-4000-8000-000000000005';

const prismaMock = { $queryRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: (_recordType, _options) => {
    const middleware = (_req, _res, next) => next();
    return middleware;
  },
  phiAccessLogger: (recordType) => {
    const middleware = (_req, _res, next) => next();
    middleware.__phiAccess = { recordType };
    return middleware;
  },
}));

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: (...roles) => {
    const middleware = (_req, _res, next) => next();
    middleware.__roles = roles;
    return middleware;
  },
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options) => {
    const middleware = (_req, _res, next) => next();
    middleware.__idempotency = options;
    return middleware;
  },
}));

jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  enforceStaffClinicalWriteDevicePosture: function enforceStaffClinicalWriteDevicePosture(
    _req,
    _res,
    next,
  ) {
    next();
  },
}));

jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizeAllBodyStrings: (_req, _res, next) => next(),
}));

const controllerNames = [
  'listIndents',
  'getIndent',
  'listInventoryCandidates',
  'recoverNotificationCoverage',
  'createIndent',
  'reserveIndent',
  'markShortSupply',
  'proposeSubstitution',
  'approveSubstitution',
  'rejectSubstitution',
  'applyApprovedSubstitution',
  'approveIndent',
  'rejectIndent',
  'recordControlledHandoff',
  'requestControlledWitness',
  'approveControlledWitness',
  'issueIndent',
  'receiveIndent',
  'requestReturn',
  'reportDiscrepancy',
  'reconcileIndent',
  'cancelIndent',
  'closeIndent',
];
jest.unstable_mockModule('../../controllers/pharmacy/wardIndentController.js', () => (
  Object.fromEntries(controllerNames.map((name) => [name, jest.fn()]))
));

const guards = await import('../../routes/pharmacy/wardIndentPatientGuards.js');
const {
  default: router,
  normalizeWardControlledHandoffEvidence,
  WARD_INDENT_CONTROLLED_HANDOFF_ROLES,
  WARD_INDENT_HOST_ROLES,
} = await import('../../routes/pharmacy/wardIndentRoutes.js');
const ipdAliasSource = readFileSync(
  new URL('../../routes/ipd/ipdSupportRoutes.js', import.meta.url),
  'utf8',
);
const appSource = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const ipdServiceSource = readFileSync(
  new URL('../../services/ipd/ipdSupportService.js', import.meta.url),
  'utf8',
);
const workflowSource = readFileSync(
  new URL('../../services/ipd/wardIndentWorkflowService.js', import.meta.url),
  'utf8',
);

function route(path, method) {
  return router.stack.find((layer) => layer.route?.path === path && layer.route.methods?.[method]);
}

function metadata(path, method, key) {
  const layer = route(path, method);
  expect(layer).toBeDefined();
  return layer.route.stack.map((stack) => stack.handle?.[key]).filter(Boolean);
}

const MUTATIONS = [
  ['/', 'ward_indent_create'],
  ['/:id/reserve', 'ward_indent_reserve'],
  ['/:id/short-supply', 'ward_indent_short_supply'],
  ['/:id/substitutions', 'ward_indent_substitution_propose'],
  ['/:id/substitutions/approve', 'ward_indent_substitution_approve'],
  ['/:id/substitutions/reject', 'ward_indent_substitution_reject'],
  ['/:id/approve', 'ward_indent_approve'],
  ['/:id/reject', 'ward_indent_reject'],
  ['/:id/controlled-handoff', 'ward_indent_controlled_handoff'],
  ['/:id/issue', 'ward_indent_issue'],
  ['/:id/receive', 'ward_indent_receive'],
  ['/:id/returns', 'ward_indent_return_request'],
  ['/:id/discrepancies', 'ward_indent_discrepancy'],
  ['/:id/reconcile', 'ward_indent_reconcile'],
  ['/:id/cancel', 'ward_indent_cancel'],
  ['/:id/close', 'ward_indent_close'],
];

test('all canonical and IPD-alias ward-indent mutations require desktop or tablet posture', () => {
  for (const [path] of MUTATIONS) {
    const layer = route(path, 'post');
    const handlers = layer.route.stack.map((entry) => entry.handle?.name);
    expect(handlers).toContain('enforceStaffClinicalWriteDevicePosture');
  }

  expect(ipdAliasSource).toContain(
    "import { enforceStaffClinicalWriteDevicePosture } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';",
  );
  const helper = ipdAliasSource.slice(
    ipdAliasSource.indexOf('function wardIndentIdempotency'),
    ipdAliasSource.indexOf('function wardIndentMutationContext'),
  );
  expect(helper).toContain('enforceStaffClinicalWriteDevicePosture');
});

test('both create aliases defer medication-line authority to the fail-closed service boundary', () => {
  expect(ipdAliasSource).toContain('items,');
  expect(ipdServiceSource).toContain('loadWardIndentCatalogClassificationsTx(tx');
  expect(ipdServiceSource).toContain("indentType === 'pharmacy'");
  expect(ipdServiceSource).toContain('WARD_INDENT_MIXED_CLINICAL_CLASSIFICATION');
  expect(ipdServiceSource).toContain('WARD_INDENT_CLINICAL_ORDER_REQUIRED');
  expect(ipdServiceSource).toContain('WARD_INDENT_CLINICAL_ORDER_CATALOG_MISMATCH');
  expect(ipdServiceSource).toContain('WARD_INDENT_CLINICAL_ORDER_QUANTITY_MISMATCH');
  expect(ipdServiceSource).toContain('WARD_INDENT_CLINICAL_ORDER_UNIT_MISMATCH');
});

test('legacy unlinked pharmacy rows abort before inventory or billing issue', () => {
  const bindingStart = workflowSource.indexOf(
    'async function assertWardIndentMedicationBindingAtIssueTx',
  );
  const issueStart = workflowSource.indexOf('export async function issueWardIndent');
  const issueEnd = workflowSource.indexOf('export async function receiveWardIndent', issueStart);
  const binding = workflowSource.slice(bindingStart, issueStart);
  const issue = workflowSource.slice(issueStart, issueEnd);
  expect(binding).toContain('loadWardIndentCatalogClassificationsTx(tx');
  expect(binding).toContain('WARD_INDENT_CLINICAL_ORDER_REQUIRED');
  expect(binding).toContain("current.indent_type === 'pharmacy'");
  expect(binding).toContain('FOR UPDATE OF clinical_order');
  expect(binding).toContain("lower(status) IN ('verified', 'in_progress')");
  expect(binding).toContain('if (progressedRows.length !== 1)');
  expect(issue).toContain('assertWardIndentMedicationBindingAtIssueTx(tx, current)');
  expect(issue.indexOf('assertWardIndentMedicationBindingAtIssueTx(tx, current)')).toBeLessThan(
    issue.indexOf('issueWardIndentInventoryTx'),
  );
});

test('medication substitution is compatibility-gated at proposal, approval, and issue', () => {
  const compatibilityStart = workflowSource.indexOf(
    'function medicationSubstitutionMismatches',
  );
  const compatibilityEnd = workflowSource.indexOf(
    'export async function loadMedicationCatalogAuthorityTx',
    compatibilityStart,
  );
  const compatibility = workflowSource.slice(compatibilityStart, compatibilityEnd);
  expect(compatibility).toContain('composition_id_missing');
  expect(compatibility).toContain("composition_confidence) !== 'high'");
  expect(compatibility).toContain('composition_source_missing');
  expect(compatibility).toContain("'strength_key', 'strength'");
  expect(compatibility).toContain("'form_key', 'form'");
  expect(compatibility).toContain("mismatches.push('route')");
  expect(compatibility).toContain('exactStrengthComponentsMatch');
  expect(compatibility).toContain('provenance_sha256');
  expect(compatibility).toContain('WARD_INDENT_MEDICATION_SUBSTITUTION_INCOMPATIBLE');

  const proposeStart = workflowSource.indexOf('export async function proposeWardIndentSubstitution');
  const approveStart = workflowSource.indexOf('export async function approveWardIndentSubstitution');
  const rejectStart = workflowSource.indexOf('export async function rejectWardIndentSubstitution');
  const proposal = workflowSource.slice(proposeStart, approveStart);
  const approval = workflowSource.slice(approveStart, rejectStart);
  expect(proposal).toContain("phase: 'proposal'");
  expect(approval).toContain("phase: 'approval'");

  const bindingStart = workflowSource.indexOf(
    'async function assertWardIndentMedicationBindingAtIssueTx',
  );
  const issueStart = workflowSource.indexOf('export async function issueWardIndent');
  const binding = workflowSource.slice(bindingStart, issueStart);
  expect(binding).toContain('Number(item.original_pharmacy_catalog_id)');
  expect(binding).toContain('catalogIds,\n    lock: true');
  expect(binding).toContain('originalCatalog: catalogById.get(originalCatalogId)');
  expect(binding).toContain('substituteCatalog: catalogById.get(currentCatalogId)');
  expect(binding).toContain("phase: 'issue'");
  expect(binding).toContain('substitutionCompatibilityEvidence');
});

describe('ward-indent patient selectors', () => {
  beforeEach(() => prismaMock.$queryRawUnsafe.mockReset());

  test('row selector is tenant-bound and resolves only PATIENT identities', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 7, uid: PATIENT }]);
    const row = await guards.selectWardIndentPatient((req) => req.params.id)({
      params: { id: '41' },
      tenantId: TENANT,
    });
    expect(row).toEqual({ id: 7, uid: PATIENT });
    const [sql, tenantId, indentId] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('indent.tenant_id = $1::uuid');
    expect(sql).toContain('LEFT JOIN admissions admission');
    expect(sql).toContain('COALESCE(indent.patient_uid, admission.patient_uid)');
    expect(sql).toContain("patient.role = 'PATIENT'");
    expect([tenantId, indentId]).toEqual([TENANT, 41]);
  });

  test('create selector resolves an admission authoritatively and rejects junk before querying', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 7, uid: PATIENT }]);
    await expect(guards.selectWardIndentCreatePatient({
      body: { admission_id: '12' },
      tenantId: TENANT,
    })).resolves.toEqual({ id: 7, uid: PATIENT });
    const [sql, tenantId, admissionId] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('admission.tenant_id = $1::uuid');
    expect(sql).toContain("patient.role = 'PATIENT'");
    expect([tenantId, admissionId]).toEqual([TENANT, 12]);
    prismaMock.$queryRawUnsafe.mockClear();
    await expect(guards.selectWardIndentCreatePatient({
      body: { admission_id: 'not-an-id' },
      tenantId: TENANT,
    })).resolves.toBeNull();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('authoritative pharmacy ward-indent router', () => {
  test.each(MUTATIONS)('%s is patient-guarded and fail-closed idempotent', (path, scope) => {
    expect(metadata(path, 'post', '__patientGuard')).toEqual([
      expect.objectContaining({
        recordType: 'PHARMACY_ORDER',
        careTeamModeGoverned: true,
        hasSelector: true,
      }),
    ]);
    expect(metadata(path, 'post', '__idempotency')).toEqual([
      expect.objectContaining({ required: true, retainOnServerError: true, scope }),
    ]);
  });

  test('canonical idempotency paths are identical across pharmacy aliases', () => {
    const create = metadata('/', 'post', '__idempotency')[0];
    const receive = metadata('/:id/receive', 'post', '__idempotency')[0];
    expect(create.requestPathForIdempotency).toBe('/api/v1/pharmacy-orders/ward-indents');
    expect(receive.requestPathForIdempotency({ params: { id: 71 } }))
      .toBe('/api/v1/pharmacy-orders/ward-indents/71/receive');
  });

  test('operator notification recovery is ordered before /:id and governed end to end', () => {
    const recoveryPath = '/notification-coverage/recover';
    const recoveryIndex = router.stack.findIndex((layer) => (
      layer.route?.path === recoveryPath && layer.route.methods?.post
    ));
    const rowIndex = router.stack.findIndex((layer) => (
      layer.route?.path === '/:id' && layer.route.methods?.get
    ));
    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeLessThan(rowIndex);

    expect(metadata(recoveryPath, 'post', '__roles')).toEqual([[
      'PHARMACY_INCHARGE',
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'ICU_INCHARGE',
      'SUPER_ADMIN',
      'ADMIN',
    ]]);
    expect(metadata(recoveryPath, 'post', '__idempotency')).toEqual([
      expect.objectContaining({
        required: true,
        retainOnServerError: true,
        scope: 'ward_indent_notification_coverage_recover',
        requestPathForIdempotency:
          '/api/v1/pharmacy-orders/ward-indents/notification-coverage/recover',
      }),
    ]);
    expect(metadata(recoveryPath, 'post', '__phiAccess')).toEqual([
      { recordType: 'PHARMACY_ORDER' },
    ]);
    const handlers = route(recoveryPath, 'post').route.stack.map((entry) => entry.handle?.name);
    expect(handlers).toContain('enforceStaffClinicalWriteDevicePosture');
  });

  test('supply, prescriber, receipt, and reconciliation roles remain separated', () => {
    const issue = metadata('/:id/issue', 'post', '__roles')[0];
    expect(issue).toEqual(expect.arrayContaining(['PHARMACIST', 'PHARMACY_INCHARGE']));
    expect(issue).not.toContain('NURSING_STAFF');
    const substitution = metadata('/:id/substitutions/approve', 'post', '__roles')[0];
    expect(substitution).toEqual(expect.arrayContaining(['DOCTOR', 'CONSULTANT']));
    expect(substitution).not.toContain('PHARMACY_STAFF');
    const receive = metadata('/:id/receive', 'post', '__roles')[0];
    expect(receive).toEqual(expect.arrayContaining(['NURSING_STAFF', 'ICU_NURSE']));
    expect(receive).not.toContain('PHARMACY_STAFF');
    expect(metadata('/:id/reconcile', 'post', '__roles')[0]).toEqual([
      'PHARMACY_INCHARGE',
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'ICU_INCHARGE',
    ]);
  });

  test('controlled handoff and witness ceremony admit only canonical pharmacy operators', () => {
    expect(WARD_INDENT_CONTROLLED_HANDOFF_ROLES).toEqual([
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
    ]);
    for (const path of [
      '/:id/controlled-handoff',
      '/:id/controlled-handoff/witness-approvals',
      '/:id/controlled-handoff/witness-approvals/:approvalId/approve',
    ]) {
      const roles = metadata(path, 'post', '__roles')[0];
      expect(roles).toEqual(WARD_INDENT_CONTROLLED_HANDOFF_ROLES);
      expect(roles).not.toEqual(expect.arrayContaining([
        'SUPER_ADMIN',
        'ADMIN',
        'PHARMACIST',
        'STORES_PURCHASE_INCHARGE',
      ]));
    }
  });

  test('controlled handoff accepts only nested exact historical recovery evidence', () => {
    expect(normalizeWardControlledHandoffEvidence([
      {
        item_id: '71',
        historical_recovery: {
          movement_id: '801',
          register_id: 901,
          reason: '  Verified against the signed ward register  ',
        },
      },
    ])).toEqual([
      {
        item_id: 71,
        historical_recovery: {
          movement_id: 801,
          register_id: 901,
          reason: 'Verified against the signed ward register',
        },
      },
    ]);
    expect(() => normalizeWardControlledHandoffEvidence([
      { item_id: 71, movement_id: 801, register_id: 901 },
    ])).toThrow(/movement_id is not permitted/);
    expect(() => normalizeWardControlledHandoffEvidence([
      {
        item_id: 71,
        historical_recovery: { movement_id: 801, register_id: 901, reason: ' ' },
      },
    ])).toThrow(/reason is required/);
    const maximumReason = 'r'.repeat(2000);
    expect(normalizeWardControlledHandoffEvidence([
      {
        item_id: 71,
        historical_recovery: {
          movement_id: 801,
          register_id: 901,
          reason: maximumReason,
        },
      },
    ])[0].historical_recovery.reason).toBe(maximumReason);
    let overlongReasonError = null;
    try {
      normalizeWardControlledHandoffEvidence([
        {
          item_id: 71,
          historical_recovery: {
            movement_id: 801,
            register_id: 901,
            reason: 'r'.repeat(2001),
          },
        },
      ]);
    } catch (error) {
      overlongReasonError = error;
    }
    expect(overlongReasonError).toMatchObject({
      statusCode: 400,
      code: 'WARD_INDENT_CONTROLLED_RECOVERY_REASON_TOO_LONG',
      details: {
        field: 'item_evidence[0].historical_recovery.reason',
        max_length: 2000,
      },
    });
    expect(() => normalizeWardControlledHandoffEvidence([
      {
        item_id: 71,
        witness_approval_id: 'approval-1',
        historical_recovery: { movement_id: 801, register_id: 901, reason: 'verified' },
      },
    ])).toThrow(/mutually exclusive/);
  });

  test('controlled handoff keeps workflow ownership and service custody fail-closed', () => {
    expect(workflowSource).toMatch(
      /controlled_handoff_required:\s*\{\s*ownerRoles:\s*CONTROLLED_HANDOFF_OWNERS/,
    );
    expect(workflowSource).toMatch(
      /recordWardIndentControlledHandoff[\s\S]*?facilityGrantRoles:\s*CONTROLLED_HANDOFF_OWNERS/,
    );
    expect(workflowSource).toContain('WARD_ITEM_PRELINKED_IN_PENDING_STATE');
    expect(workflowSource).toContain('MOVEMENT_FACILITY_MISMATCH');
    expect(workflowSource).toContain('REGISTER_FACILITY_MISMATCH');
  });

  test('supply-chain staff can read worklists without gaining request authority', () => {
    expect(metadata('/', 'get', '__roles')[0]).toContain('STORES_PURCHASE_INCHARGE');
    expect(metadata('/:id', 'get', '__roles')[0]).toContain('STORES_PURCHASE_INCHARGE');
    expect(metadata('/', 'post', '__roles')[0]).not.toContain('STORES_PURCHASE_INCHARGE');
  });

  test('mounts exact ward routes for every inner ER and stores authority without widening pharmacy', () => {
    expect(WARD_INDENT_HOST_ROLES).toEqual(expect.arrayContaining([
      'ER_STAFF',
      'STORES_PURCHASE_INCHARGE',
    ]));
    expect(metadata('/:id/receive', 'post', '__roles')[0]).toContain('ER_STAFF');
    expect(metadata('/:id/issue', 'post', '__roles')[0]).toContain('STORES_PURCHASE_INCHARGE');

    const exactMount = appSource.indexOf(
      "app.use('/api/v1/pharmacy-orders/ward-indents', patientRateLimiter, requireRole(...WARD_INDENT_HOST_ROLES)",
    );
    const broadMount = appSource.indexOf(
      "app.use('/api/v1/pharmacy-orders', patientRateLimiter, requireRole(...PHARMACY_ORDER_ROUTE_ROLES)",
    );
    expect(exactMount).toBeGreaterThan(-1);
    expect(broadMount).toBeGreaterThan(exactMount);
  });

  test('inventory candidates are tenant/patient guarded and read-only', () => {
    const candidates = metadata(
      '/:id/items/:itemId/inventory-candidates',
      'get',
      '__patientGuard',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        recordType: 'PHARMACY_ORDER',
        careTeamModeGoverned: true,
        hasSelector: true,
      }),
    ]);
    expect(metadata(
      '/:id/items/:itemId/inventory-candidates',
      'get',
      '__roles',
    )[0]).toContain('PHARMACY_INCHARGE');
  });
});

describe('IPD compatibility alias', () => {
  test('does not advertise ER or stores grants blocked by the IPD parent mount', () => {
    expect(ipdAliasSource).not.toContain("'ER_STAFF'");
    expect(ipdAliasSource).not.toContain('PHARMACY_SUPPLY_ROUTE_ROLES');
  });

  test('carries a row guard and the same durable idempotency contract on every mutation', () => {
    for (const [path, scope] of MUTATIONS.slice(1)) {
      const ipdPath = path.replace('/:id', '/ward-indents/:indentId');
      const start = ipdAliasSource.indexOf(`  '${ipdPath}',`);
      const end = ipdAliasSource.indexOf('\nrouter.', start + 1);
      expect(start).toBeGreaterThan(-1);
      const block = ipdAliasSource.slice(start, end < 0 ? undefined : end);
      expect(block).toContain('guardWardIndentRow');
      expect(block).toContain(`wardIndentIdempotency('${scope.replace('ward_indent_', '')}'`);
    }
  });

  test('guards create, filtered list, admission list, and row reads by the same subject', () => {
    expect(ipdAliasSource).toMatch(/'\/ward-indents',[\s\S]*?wardIndentCreateGuard\(\)[\s\S]*?wardIndentIdempotency\('create'\)/);
    expect(ipdAliasSource).toMatch(/router\.get\([\s\S]*?'\/ward-indents',[\s\S]*?wardIndentListGuard\(\)/);
    expect(ipdAliasSource).toMatch(/'\/admissions\/:id\/ward-indents',[\s\S]*?wardIndentAdmissionGuard/);
    expect(ipdAliasSource).toMatch(/'\/ward-indents\/:indentId',[\s\S]*?guardWardIndentRow/);
  });

  test('forwards every exact-inventory input consumed by the canonical workflow', () => {
    const actionBlock = (action) => {
      const start = ipdAliasSource.indexOf(`  '/ward-indents/:indentId/${action}',`);
      const end = ipdAliasSource.indexOf('\nrouter.', start + 1);
      expect(start).toBeGreaterThan(-1);
      return ipdAliasSource.slice(start, end < 0 ? undefined : end);
    };

    expect(actionBlock('reserve')).toContain(
      'inventorySelections: req.body?.inventory_selections ?? null',
    );
    expect(actionBlock('short-supply')).toContain(
      'inventorySelections: req.body?.inventory_selections ?? null',
    );
    expect(actionBlock('substitutions/approve')).toContain(
      'inventorySelections: req.body?.inventory_selections ?? null',
    );
    expect(actionBlock('receive')).toContain(
      'substitutionAcknowledgements: req.body?.substitution_acknowledgements ?? null',
    );
    expect(actionBlock('reconcile')).toContain(
      'allocationReturns: req.body?.allocation_returns ?? null',
    );
    expect(actionBlock('controlled-handoff')).toContain(
      'requireRole(...WARD_INDENT_CONTROLLED_HANDOFF_ROLES)',
    );
    expect(actionBlock('controlled-handoff')).toContain(
      'wardControlledHandoffEvidenceGuard',
    );
  });

  test('exposes the guarded exact inventory-candidate read needed to choose batches', () => {
    const path = '/ward-indents/:indentId/items/:itemId/inventory-candidates';
    const start = ipdAliasSource.indexOf(`  '${path}',`);
    const end = ipdAliasSource.indexOf('\nrouter.', start + 1);
    expect(start).toBeGreaterThan(-1);
    const block = ipdAliasSource.slice(start, end < 0 ? undefined : end);
    expect(block).toContain('requireRole(...WARD_INDENT_READ_ROLES)');
    expect(block).toContain('guardWardIndentRow');
    expect(block).toContain('listWardIndentInventoryCandidates');
    expect(block).toContain('wardIndentId: indentId');
  });
});
