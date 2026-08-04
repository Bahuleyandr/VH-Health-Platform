import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import {
  parseI23ClinicalTrialRecoveryPayload,
} from '../../services/integrations/externalClinicalTrialRecoveryService.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function payload() {
  const providerPage = JSON.stringify({ studies: [], nextPageToken: 'opaque-next' });
  return {
    schema: 'vhhealth.i23.clinical-trial-page-owner-reconciliation/v1',
    sync_run_id: 41,
    source_partition: `clinicaltrials_gov_v2:${'a'.repeat(64)}`,
    provider_revision: '2026-08-04T04:30:00Z',
    provider_page_token: 'opaque-current',
    provider_page_sha256: sha256(providerPage),
    provider_page: providerPage,
    occurred_at: '2026-08-04T04:31:00.000Z',
  };
}

describe('I23 clinical trial provider-page recovery', () => {
  it('parses a closed envelope and verifies exact provider page bytes', () => {
    expect(parseI23ClinicalTrialRecoveryPayload(JSON.stringify(payload()))).toMatchObject({
      syncRunId: 41,
      providerPageToken: 'opaque-current',
      providerNextPageToken: 'opaque-next',
    });
  });

  it.each([
    value => ({ ...value, extra: true }),
    value => ({ ...value, provider_page_sha256: 'b'.repeat(64) }),
    value => ({ ...value, provider_page: JSON.stringify({ nextPageToken: null }) }),
  ])('fails closed on malformed occurrence evidence', mutate => {
    expect(() => parseI23ClinicalTrialRecoveryPayload(JSON.stringify(mutate(payload()))))
      .toThrow(expect.objectContaining({ code: 'I23_TRIAL_RECOVERY_INVALID' }));
  });

  it('records complete-page evidence rather than status or upsert coverage', () => {
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I23' })).toMatchObject({
      implemented: true,
      partitionKind: 'stable_canonical_query',
      cursorEvidence: 'complete_provider_page_only',
      pageAtomicity: 'catalog_upserts_and_page_completion_one_transaction',
      statusSemantics: 'completed_and_upsert_coverage_are_not_hwm',
    });
  });
});
