// Care-team CONTEXT SHAPE contract.
//
// The patient-access engine honours exactly three care-team shapes. Anything
// else confers no access at all. Before this contract existed, the admin
// care-team API happily persisted the other shapes: the row inserted, the API
// returned 201, and the clinician the operator was trying to unblock still got
// a 403 with nothing anywhere saying why. That is what made
// `emr-chart-read.test.js` red — its fixture seeded a context-free 'op' team,
// which matches none of the engine's branches.
//
// These tests pin BOTH halves together:
//   * the classifier's verdicts, and
//   * the claim that the classifier still describes the live engine SQL —
//     read out of accessDecisionService.js itself, so widening or narrowing a
//     branch without updating the write path fails here.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARE_TEAM_CONTEXT_SHAPES,
  CARE_TEAM_SHAPE_REJECTIONS,
  CONTEXT_FREE_TEAM_KIND,
  classifyCareTeamContextShape,
  normalizeTeamKind,
} from '../../config/careTeamContextShapes.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engineSource = readFileSync(
  path.join(backendRoot, 'services/security/accessDecisionService.js'),
  'utf8',
);

describe('classifyCareTeamContextShape — honourable shapes', () => {
  it('accepts a context-free longitudinal team', () => {
    expect(classifyCareTeamContextShape({ teamKind: 'longitudinal' })).toMatchObject({
      honourable: true,
      shape: CARE_TEAM_CONTEXT_SHAPES.LONGITUDINAL,
      code: null,
    });
  });

  it('accepts an appointment-scoped team of any kind', () => {
    expect(classifyCareTeamContextShape({ teamKind: 'op', appointmentId: 42 })).toMatchObject({
      honourable: true,
      shape: CARE_TEAM_CONTEXT_SHAPES.APPOINTMENT,
    });
  });

  it('accepts an admission-scoped team of any kind', () => {
    expect(classifyCareTeamContextShape({ teamKind: 'ip', admissionId: 7 })).toMatchObject({
      honourable: true,
      shape: CARE_TEAM_CONTEXT_SHAPES.ADMISSION,
    });
  });

  it('normalizes team_kind exactly as the SQL does (case + surrounding blanks)', () => {
    expect(normalizeTeamKind('  LONGITUDINAL  ')).toBe('longitudinal');
    expect(classifyCareTeamContextShape({ teamKind: '  Longitudinal ' }).honourable).toBe(true);
  });
});

describe('classifyCareTeamContextShape — shapes the engine cannot honour', () => {
  // Every non-longitudinal kind permitted by the migration-260 CHECK.
  it.each(['op', 'ip', 'er', 'icu', 'day_care', 'dialysis', 'perioperative', 'other'])(
    'rejects a context-free %s team instead of letting it grant nothing',
    (teamKind) => {
      const verdict = classifyCareTeamContextShape({ teamKind });
      expect(verdict.honourable).toBe(false);
      expect(verdict.code).toBe(CARE_TEAM_SHAPE_REJECTIONS.CONTEXT_FREE_REQUIRES_LONGITUDINAL);
      expect(verdict.reason).toContain(CONTEXT_FREE_TEAM_KIND);
    },
  );

  it('rejects a missing/blank team_kind with no episode context', () => {
    expect(classifyCareTeamContextShape({}).honourable).toBe(false);
    expect(classifyCareTeamContextShape({ teamKind: '   ' }).honourable).toBe(false);
  });

  it('rejects a dual-context team rather than guessing which episode governs it', () => {
    const verdict = classifyCareTeamContextShape({
      teamKind: 'longitudinal',
      admissionId: 3,
      appointmentId: 9,
    });
    expect(verdict.honourable).toBe(false);
    expect(verdict.code).toBe(CARE_TEAM_SHAPE_REJECTIONS.AMBIGUOUS_EPISODE_CONTEXT);
  });

  it('treats null/undefined/empty-string episode ids as absent, like SQL NULL', () => {
    expect(classifyCareTeamContextShape({
      teamKind: 'op', admissionId: null, appointmentId: '',
    }).honourable).toBe(false);
  });
});

describe('the classifier still describes the live access-engine SQL', () => {
  it('pins branch 1 — context-free requires longitudinal', () => {
    expect(engineSource).toMatch(
      /ct\.appointment_id IS NULL\s*\n\s*AND ct\.admission_id IS NULL\s*\n\s*AND LOWER\(BTRIM\(COALESCE\(ct\.team_kind, ''\)\)\) = 'longitudinal'/,
    );
  });

  it('pins branch 2 — appointment-scoped excludes an admission id', () => {
    expect(engineSource).toMatch(
      /ct\.appointment_id IS NOT NULL\s*\n\s*AND ct\.admission_id IS NULL/,
    );
  });

  it('pins branch 3 — admission-scoped excludes an appointment id', () => {
    expect(engineSource).toMatch(
      /ct\.admission_id IS NOT NULL\s*\n\s*AND ct\.appointment_id IS NULL/,
    );
  });

  it('pins that there are exactly three branches, so no fourth shape is silently honoured', () => {
    const branchCount = (engineSource.match(/ct\.(admission|appointment)_id IS (NOT )?NULL/g) || []).length;
    // branch 1 contributes 2, branches 2 and 3 contribute 2 each.
    expect(branchCount).toBe(6);
  });
});
