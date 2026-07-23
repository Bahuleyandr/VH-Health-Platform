import {
  REFERRAL_REQUEST_TO_CLOSURE_DEFINITION,
  compileReferralRequestToClosureDefinition,
} from '../../services/pathways/referralPathwayDefinition.js';
import {
  REFERRAL_PATHWAY_RUNTIME_HANDLERS,
} from '../../services/pathways/referralPathwayHandlers.js';

describe('referral request-to-closure pathway definition', () => {
  it('compiles the reviewed step order against the production registry', () => {
    const compiled = compileReferralRequestToClosureDefinition();

    expect(compiled.workflow_key).toBe('referral_request_to_closure');
    expect(compiled.version).toBe(1);
    expect(compiled.steps.map((step) => step.step_key)).toEqual([
      'await_receiver_acceptance',
      'await_signed_response',
      'await_originator_closure',
      'finalize_referral_pathway',
    ]);
    expect(compiled.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(REFERRAL_REQUEST_TO_CLOSURE_DEFINITION)).toBe(true);
  });

  it('does not treat a seen referral as accepted ownership', async () => {
    const seenOnly = {
      referral_found: true,
      status: 'pending',
      closure_status: 'open',
      accepted_by: null,
      ownership_accepted_at: null,
      current_owner_uid: null,
    };

    await expect(REFERRAL_PATHWAY_RUNTIME_HANDLERS.receiverAcceptance.evaluate({
      loadedEvidence: seenOnly,
    })).resolves.toMatchObject({ decision: 'blocked' });
  });

  it('requires named ownership acceptance, a signature, and explicit closure evidence', async () => {
    const accepted = {
      referral_found: true,
      status: 'accepted',
      closure_status: 'open',
      accepted_by: 'doctor-1',
      ownership_accepted_at: new Date(),
      current_owner_uid: 'doctor-1',
      response_signed: false,
    };

    await expect(REFERRAL_PATHWAY_RUNTIME_HANDLERS.receiverAcceptance.evaluate({
      loadedEvidence: accepted,
    })).resolves.toMatchObject({ decision: 'receiver_accepted' });
    await expect(REFERRAL_PATHWAY_RUNTIME_HANDLERS.signedResponse.evaluate({
      loadedEvidence: accepted,
    })).resolves.toMatchObject({ decision: 'blocked' });
    await expect(REFERRAL_PATHWAY_RUNTIME_HANDLERS.originatorClosure.evaluate({
      loadedEvidence: { ...accepted, response_signed: true },
    })).resolves.toMatchObject({ decision: 'blocked' });
    await expect(REFERRAL_PATHWAY_RUNTIME_HANDLERS.originatorClosure.evaluate({
      loadedEvidence: { ...accepted, response_signed: true, closure_status: 'closed' },
    })).resolves.toMatchObject({ decision: 'referral_closed' });
  });
});
