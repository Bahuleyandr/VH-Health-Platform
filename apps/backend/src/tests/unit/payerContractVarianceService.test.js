import {
  classifyVariance,
  matchClaimToContract,
  suggestActions,
} from '../../services/ai/payerContractVarianceService.js';

describe('payer contract variance helpers', () => {
  describe('classifyVariance', () => {
    it('returns missing_contract when no expected rate is known', () => {
      const result = classifyVariance({ expectedMinor: null, paidMinor: 5000 });
      expect(result.variance_category).toBe('missing_contract');
      expect(result.variance_band).toBe('review');
    });

    it('returns missing_payment when no paid amount is recorded', () => {
      const result = classifyVariance({ expectedMinor: 12000, paidMinor: null, claimAmountMinor: 12000 });
      expect(result.variance_category).toBe('missing_payment');
      expect(result.variance_band).toBe('investigate');
    });

    it('returns match + within_tolerance when paid is within tolerance', () => {
      const result = classifyVariance({ expectedMinor: 10000, paidMinor: 10150, tolerancePct: 2 });
      expect(result.variance_category).toBe('match');
      expect(result.variance_band).toBe('within_tolerance');
      expect(result.variance_pct).toBeGreaterThan(0);
    });

    it('flags underpayment as review when just outside tolerance', () => {
      const result = classifyVariance({ expectedMinor: 10000, paidMinor: 9700, tolerancePct: 2 });
      expect(result.variance_category).toBe('underpayment');
      expect(result.variance_band).toBe('review');
    });

    it('flags underpayment as investigate when >= 5% below contracted rate', () => {
      const result = classifyVariance({ expectedMinor: 10000, paidMinor: 9400, tolerancePct: 2 });
      expect(result.variance_category).toBe('underpayment');
      expect(result.variance_band).toBe('investigate');
    });

    it('escalates underpayment at >= 15% below contracted rate', () => {
      const result = classifyVariance({ expectedMinor: 10000, paidMinor: 8400, tolerancePct: 2 });
      expect(result.variance_category).toBe('underpayment');
      expect(result.variance_band).toBe('escalate');
      expect(result.variance_pct).toBeCloseTo(-16, 0);
    });

    it('flags overpayment when paid exceeds tolerance', () => {
      const result = classifyVariance({ expectedMinor: 10000, paidMinor: 10400, tolerancePct: 2 });
      expect(result.variance_category).toBe('overpayment');
      expect(result.variance_band).toBe('review');
    });

    it('treats very small overpayments (within tolerance) as match', () => {
      const result = classifyVariance({ expectedMinor: 10000, paidMinor: 10100, tolerancePct: 2 });
      expect(result.variance_category).toBe('match');
      expect(result.variance_band).toBe('within_tolerance');
    });
  });

  describe('matchClaimToContract', () => {
    const claim = {
      id: 1,
      insurance_provider: 'Acme Health',
      submitted_at: '2026-03-15T10:00:00Z',
      procedure_code: '31622',
    };

    it('matches by payer name + procedure code (case insensitive)', () => {
      const contracts = [
        { id: 5, payer_name: 'acme health', procedure_code: '31622', active: true, effective_start_date: '2026-01-01' },
      ];
      expect(matchClaimToContract({ claim, contracts })?.id).toBe(5);
    });

    it('returns null when payer does not match', () => {
      const contracts = [{ id: 6, payer_name: 'Another', procedure_code: '31622', active: true }];
      expect(matchClaimToContract({ claim, contracts })).toBeNull();
    });

    it('skips contracts outside effective date window', () => {
      const contracts = [
        { id: 7, payer_name: 'Acme Health', procedure_code: '31622', active: true, effective_start_date: '2026-06-01' },
      ];
      expect(matchClaimToContract({ claim, contracts })).toBeNull();
    });

    it('skips inactive contracts', () => {
      const contracts = [
        { id: 8, payer_name: 'Acme Health', procedure_code: '31622', active: false, effective_start_date: '2026-01-01' },
      ];
      expect(matchClaimToContract({ claim, contracts })).toBeNull();
    });

    it('accepts an explicit procedureCode override', () => {
      const contracts = [
        { id: 9, payer_name: 'Acme Health', procedure_code: '99213', active: true, effective_start_date: '2026-01-01' },
      ];
      expect(matchClaimToContract({ claim, contracts, procedureCode: '99213' })?.id).toBe(9);
    });
  });

  describe('suggestActions', () => {
    it('proposes appeal + escalation for underpayment', () => {
      const variance = { variance_category: 'underpayment', variance_band: 'escalate' };
      const actions = suggestActions({ variance });
      expect(actions.some((line) => /appeal|recoupment/i.test(line))).toBe(true);
      expect(actions.some((line) => /escalate/i.test(line))).toBe(true);
    });

    it('proposes reconciliation for overpayment', () => {
      const variance = { variance_category: 'overpayment', variance_band: 'review' };
      const actions = suggestActions({ variance });
      expect(actions.some((line) => /reconcile/i.test(line))).toBe(true);
    });

    it('proposes contract registry addition when contract is missing', () => {
      const variance = { variance_category: 'missing_contract', variance_band: 'review' };
      const actions = suggestActions({ variance });
      expect(actions.some((line) => /add a contracted rate/i.test(line))).toBe(true);
    });

    it('prepends denied-claim note when claim is denied', () => {
      const variance = { variance_category: 'underpayment', variance_band: 'investigate' };
      const actions = suggestActions({ variance, claim: { status: 'denied' } });
      expect(actions[0].toLowerCase()).toContain('denied');
    });
  });
});
