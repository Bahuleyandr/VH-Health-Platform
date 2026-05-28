import { buildOrganizationHierarchy } from '../../services/staff/organizationHierarchyService.js';

describe('organization hierarchy service', () => {
  it('separates housekeeping work supervision from HR leave process', () => {
    const chart = buildOrganizationHierarchy({
      tenantScoped: true,
      roleCounts: {
        HOUSEKEEPING_INCHARGE: 1,
        HOUSEKEEPING_STAFF: 5,
      },
    });

    const housekeepingWork = chart.edges.find((edge) =>
      edge.from === 'operations_incharge'
      && edge.to === 'housekeeping_incharge'
      && edge.type === 'work'
    );
    const housekeepingLeave = chart.edges.find((edge) =>
      edge.from === 'hr_manager'
      && edge.to === 'housekeeping_incharge'
      && edge.type === 'leave'
    );
    const housekeepingNode = chart.nodes.find((node) => node.id === 'housekeeping_staff');

    expect(housekeepingWork).toBeTruthy();
    expect(housekeepingLeave).toEqual(
      expect.objectContaining({
        label: expect.stringMatching(/Leave records only/i),
      })
    );
    expect(housekeepingNode).toEqual(
      expect.objectContaining({
        active_staff_count: 5,
      })
    );
  });

  it('states that HR process authority cannot silently become operational command', () => {
    const chart = buildOrganizationHierarchy();
    const hrBoundary = chart.role_boundaries.find((boundary) =>
      boundary.role_codes.includes('HR_STAFF')
    );

    expect(chart.tenant_scoped).toBe(false);
    expect(chart.counts_status).toBe('tenant-unavailable');
    expect(hrBoundary).toEqual(
      expect.objectContaining({
        cannot: expect.stringMatching(/clinical work|housekeeping floor work|maintenance work/i),
      })
    );
    expect(chart.guardrails).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/platform access, work supervision, and HR leave approval/i),
      ])
    );
  });
});
