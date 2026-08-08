import { readFileSync } from 'node:fs';

const projector = readFileSync(
  new URL('../../services/pathways/referralPathwayProjector.js', import.meta.url),
  'utf8',
);

describe('Referral pathway projector query shape', () => {
  it('never uses SELECT * (house convention: explicit column lists)', () => {
    expect(projector).not.toMatch(/SELECT\s+\*/i);
  });

  it('enumerates exactly the pathway-instance columns the projector consumes', () => {
    expect(projector).toContain('SELECT id, clinical_status');
    expect(projector).toContain('FROM care_pathway_instances');
  });
});
