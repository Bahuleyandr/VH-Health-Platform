import fs from 'node:fs';
import {
  REQUIRED_EVIDENCE_CONTROLS,
  evidenceAcceptanceIssues,
  makeEvidenceTemplate,
} from '../../../scripts/indiaDeployabilityControls.mjs';
import { splitStatements } from '../../utils/migrations/splitStatements.js';

describe('india deployability evidence controls', () => {
  it('requires evidence URI, verifier, and timestamp for verified rows', () => {
    expect(evidenceAcceptanceIssues({ status: 'verified' })).toEqual([
      'missing_evidence_uri',
      'missing_verified_by',
      'missing_verified_at',
    ]);
  });

  it('requires notes for accepted exceptions', () => {
    expect(evidenceAcceptanceIssues({
      status: 'accepted_exception',
      evidence_uri: 'evidence://risk-register/123',
      verified_by: '00000000-0000-4000-8000-000000000001',
      verified_at: '2026-06-12T00:00:00.000Z',
    })).toEqual(['missing_accepted_exception_notes']);
  });

  it('accepts a complete verified row', () => {
    expect(evidenceAcceptanceIssues({
      status: 'verified',
      evidence_uri: 'evidence://india/DPDP_NOTICE_PURPOSE_MAP',
      verified_by: '00000000-0000-4000-8000-000000000001',
      verified_at: '2026-06-12T00:00:00.000Z',
    })).toEqual([]);
  });

  it('generates one template entry for every required control', () => {
    const template = makeEvidenceTemplate();
    expect(template.controls).toHaveLength(REQUIRED_EVIDENCE_CONTROLS.length);
    expect(template.controls.map((control) => control.control_code))
      .toContain('PHARMACY_LICENSE_PRESCRIPTION_CONTROL');
  });

  it('keeps the migration guard focused on accepted evidence metadata', () => {
    const sql = fs.readFileSync(
      new URL('../../migrations/302_india_evidence_acceptance_guard.sql', import.meta.url),
      'utf8',
    );
    const statements = splitStatements(sql).map(stripLeadingSqlComments);

    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(sql).toContain('india_compliance_evidence_acceptance_evidence_check');
    expect(sql).toContain("COALESCE(metadata, '{}'::jsonb)");
    expect(sql).toContain("status IN ('accepted_exception', 'not_applicable')");
  });
});

function stripLeadingSqlComments(statement) {
  return statement.replace(/^(?:\s*--[^\n]*(?:\n|$))+/u, '').trim();
}
