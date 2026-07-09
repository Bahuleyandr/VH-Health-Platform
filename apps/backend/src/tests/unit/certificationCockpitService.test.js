import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  getCertificationCockpit,
  __testing__,
} = await import('../../services/compliance/certificationCockpitService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('getCertificationCockpit', () => {
  it('separates accepted evidence from external certification claims', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      {
        control_code: 'ABDM_M1_CERTIFICATION_SUITE',
        control_area: 'ABDM',
        control_name: 'ABDM M1 certification suite evidence accepted',
        status: 'verified',
        evidence_uri: 'evidence://abdm/m1',
        verified_by: '11111111-1111-4111-8111-111111111111',
        verified_at: new Date('2026-07-08T00:00:00.000Z'),
        metadata: {
          nl12_s8: {
            cert_ready_declaration: 'internal_cert_ready_substrate',
            external_certification_status: 'not_certified',
            engagement_status: 'suite_result_attached',
          },
        },
        updated_at: new Date('2026-07-08T00:00:00.000Z'),
      },
      {
        control_code: 'ABDM_M2_ENCRYPTED_PUSH',
        status: 'verified',
        evidence_uri: 'evidence://abdm/m2-dry-run',
        verified_by: '11111111-1111-4111-8111-111111111111',
        verified_at: new Date('2026-07-08T00:00:00.000Z'),
        metadata: {},
      },
      {
        control_code: 'VAPT_OR_SIGNED_EXCEPTION',
        control_area: 'SECURITY',
        control_name: 'External VAPT report or signed high-risk exception attached',
        status: 'in_progress',
        evidence_uri: null,
        metadata: {
          nl12_s8: {
            engagement_status: 'external_firm_required',
            blockers: ['External report not attached.'],
          },
        },
      },
    ]);

    const cockpit = await getCertificationCockpit({ tenantId: TENANT });

    expect(cockpit.summary.total_tracks).toBe(__testing__.TRACKS.length);
    expect(cockpit.summary.accepted_count).toBe(1);
    expect(cockpit.summary.cert_ready_count).toBe(1);
    expect(cockpit.summary.externally_certified_count).toBe(0);
    expect(cockpit.declaration_boundary.rule).toMatch(/do not claim external certification/i);
    expect(cockpit.tracks.find((track) => track.key === 'abdm_m1')).toMatchObject({
      acceptance_state: 'accepted',
      external_certification_status: 'not_certified',
      blocker_count: 0,
    });
    expect(cockpit.tracks.find((track) => track.key === 'abdm_m2')?.supporting_controls[0])
      .toMatchObject({ control_code: 'ABDM_M2_ENCRYPTED_PUSH', acceptance_state: 'accepted' });
    expect(cockpit.tracks.find((track) => track.key === 'vapt')).toMatchObject({
      acceptance_state: 'open',
      blocker_count: 1,
    });
    expect(String(queryUnsafeMock.mock.calls[0][0])).toContain('control_code IN');
    expect(queryUnsafeMock.mock.calls[0].slice(2)).toEqual(__testing__.ALL_CODES);
  });

  it('degrades to open tracks when the evidence table is missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "india_compliance_evidence" does not exist'));

    const cockpit = await getCertificationCockpit({ tenantId: TENANT });

    expect(cockpit.summary.accepted_count).toBe(0);
    expect(cockpit.summary.open_count).toBe(__testing__.TRACKS.length);
    expect(cockpit.tracks.every((track) => track.acceptance_state === 'open')).toBe(true);
  });
});
