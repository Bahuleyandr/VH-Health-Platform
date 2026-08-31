import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const createProposalMock = jest.fn(async (input) => input);
const approveProposalMock = jest.fn(async (input) => input);
const idempotencyOptions = [];

jest.unstable_mockModule(
  '../../services/pharmacy/substitutionFundingReauthorisationService.js',
  () => ({
    createSubstitutionFundingProposal: createProposalMock,
    approveSubstitutionFundingProposal: approveProposalMock,
    SUBSTITUTION_FUNDING_PROPOSER_ROLES: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
    SUBSTITUTION_FUNDING_TPA_APPROVER_ROLES: [
      'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER', 'FINANCE_INCHARGE',
    ],
    SUBSTITUTION_FUNDING_PAYMENT_APPROVER_ROLES: [
      'FINANCE_INCHARGE', 'BILLING_INCHARGE',
    ],
    SUBSTITUTION_FUNDING_APPROVER_ROLES: [
      'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER', 'FINANCE_INCHARGE', 'BILLING_INCHARGE',
    ],
  }),
);
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options) => {
    idempotencyOptions.push(options);
    return (req, res, next) => {
      const requestKey = req.get('idempotency-key');
      if (options.required && !requestKey) {
        return res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      req.idempotencyClaim = { requestKey };
      return next();
    };
  },
}));

const {
  pharmacySubstitutionFundingApprovalRoutes,
  pharmacySubstitutionFundingProposalRoutes,
} = await import('../../routes/pharmacy/substitutionFundingRoutes.js');

let actorRole = 'PHARMACY_STAFF';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = TENANT;
  req.user = { uid: ACTOR, role: actorRole };
  next();
});
for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
  app.use(
    `${prefix}/orders/:orderId/substitution-funding/proposals/:approvalId/approve`,
    pharmacySubstitutionFundingApprovalRoutes,
  );
  app.use(
    `${prefix}/orders/:orderId/substitution-funding/proposals`,
    pharmacySubstitutionFundingProposalRoutes,
  );
}

beforeEach(() => {
  actorRole = 'PHARMACY_STAFF';
  createProposalMock.mockClear();
  approveProposalMock.mockClear();
});

test('both mutations require durable idempotency receipts with one canonical alias identity', () => {
  expect(idempotencyOptions).toHaveLength(2);
  expect(idempotencyOptions).toEqual(expect.arrayContaining([
    expect.objectContaining({
      required: true,
      scope: 'pharmacy_substitution_funding_proposal',
      retainOnServerError: true,
      durableDomainReceipt: true,
      revalidateCompletedReplay: true,
    }),
    expect.objectContaining({
      required: true,
      scope: 'pharmacy_substitution_funding_approval',
      retainOnServerError: true,
      durableDomainReceipt: true,
    }),
  ]));
  const proposal = idempotencyOptions.find(
    ({ scope }) => scope === 'pharmacy_substitution_funding_proposal',
  );
  const approval = idempotencyOptions.find(
    ({ scope }) => scope === 'pharmacy_substitution_funding_approval',
  );
  expect(proposal.requestPathForIdempotency({ params: { orderId: '41' } })).toBe(
    '/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals',
  );
  expect(approval.requestPathForIdempotency({
    params: { orderId: '41', approvalId: '73' },
  })).toBe(
    '/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals/73/approve',
  );
  expect(approval.revalidateCompletedReplay).toBeUndefined();
});

test('proposal binds the authenticated proposer and passes only the selector body', async () => {
  const selector = {
    order_line_index: 0,
    final_catalog_id: 51,
    inventory_item_id: 61,
    inventory_batch_id: 71,
    quantity: '2.5000',
  };
  const response = await request(app)
    .post('/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals')
    .set('Idempotency-Key', 'proposal-1')
    .send(selector);

  expect(response.statusCode).toBe(200);
  expect(createProposalMock).toHaveBeenCalledWith({
    tenantId: TENANT,
    orderId: '41',
    selector,
    proposerUid: ACTOR,
    proposerRole: 'PHARMACY_STAFF',
    idempotencyKey: 'proposal-1',
  });
});

test('approval derives the decision actor and rejects every caller-supplied decision field', async () => {
  actorRole = 'FINANCE_INCHARGE';
  const approved = await request(app)
    .post('/api/v1/pharmacy/orders/41/substitution-funding/proposals/73/approve')
    .set('Idempotency-Key', 'approval-1')
    .send({});

  expect(approved.statusCode).toBe(200);
  expect(approveProposalMock).toHaveBeenCalledWith({
    tenantId: TENANT,
    orderId: '41',
    approvalId: '73',
    approverUid: ACTOR,
    approverRole: 'FINANCE_INCHARGE',
  });

  approveProposalMock.mockClear();
  const forbidden = await request(app)
    .post('/api/v1/pharmacy/orders/41/substitution-funding/proposals/73/approve')
    .set('Idempotency-Key', 'approval-2')
    .send({ approver_uid: ACTOR, funding_amount: 999999 });
  expect(forbidden.statusCode).toBe(400);
  expect(forbidden.body.code).toBe(
    'SUBSTITUTION_FUNDING_APPROVAL_CALLER_AUTHORITY_FORBIDDEN',
  );
  expect(approveProposalMock).not.toHaveBeenCalled();
});

test('generic administrators cannot enter either domain workflow', async () => {
  for (const role of ['ADMIN', 'SUPER_ADMIN']) {
    actorRole = role;
    const proposal = await request(app)
      .post('/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals')
      .set('Idempotency-Key', `${role}-proposal`)
      .send({});
    const approval = await request(app)
      .post('/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals/73/approve')
      .set('Idempotency-Key', `${role}-approval`)
      .send({});
    expect(proposal.statusCode).toBe(403);
    expect(approval.statusCode).toBe(403);
  }
  expect(createProposalMock).not.toHaveBeenCalled();
  expect(approveProposalMock).not.toHaveBeenCalled();
});

test('missing Idempotency-Key fails before either domain service', async () => {
  const proposal = await request(app)
    .post('/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals')
    .send({});
  actorRole = 'CLAIMS_MANAGER';
  const approval = await request(app)
    .post('/api/v1/pharmacy-orders/orders/41/substitution-funding/proposals/73/approve')
    .send({});
  expect(proposal.statusCode).toBe(400);
  expect(approval.statusCode).toBe(400);
  expect(createProposalMock).not.toHaveBeenCalled();
  expect(approveProposalMock).not.toHaveBeenCalled();
});
