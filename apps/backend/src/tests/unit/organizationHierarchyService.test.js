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

  it('renders Nursing Superintendent above OP/IP/OT/Cath incharges and their staff', () => {
    const chart = buildOrganizationHierarchy({
      tenantScoped: true,
      roleCounts: {
        CNO: 1,
        IP_INCHARGE: 1,
        IP_STAFF_NURSE: 4,
        OP_INCHARGE: 1,
        OP_STAFF_NURSE: 3,
        OT_INCHARGE: 1,
        OT_NURSE: 2,
        CATH_LAB_INCHARGE: 1,
        CATH_LAB_STAFF: 2,
      },
    });

    const nursingSuperintendent = chart.nodes.find((node) => node.id === 'nursing_superintendent');
    expect(nursingSuperintendent).toEqual(expect.objectContaining({ active_staff_count: 1 }));

    for (const [incharge, staff] of [
      ['ip_nursing_incharge', 'ip_nursing_staff'],
      ['op_nursing_incharge', 'op_nursing_staff'],
      ['ot_nursing_incharge', 'ot_nursing_staff'],
      ['cath_lab_incharge', 'cath_lab_staff'],
    ]) {
      expect(chart.edges).toContainEqual(
        expect.objectContaining({
          from: 'nursing_superintendent',
          to: incharge,
          type: 'work',
        })
      );
      expect(chart.edges).toContainEqual(
        expect.objectContaining({
          from: incharge,
          to: staff,
          type: 'work',
        })
      );
    }

    expect(chart.nodes.find((node) => node.id === 'ip_nursing_staff')).toEqual(
      expect.objectContaining({ active_staff_count: 4 })
    );
    expect(chart.nodes.find((node) => node.id === 'op_nursing_staff')).toEqual(
      expect.objectContaining({ active_staff_count: 3 })
    );
    expect(chart.nodes.find((node) => node.id === 'ot_nursing_staff')).toEqual(
      expect.objectContaining({ active_staff_count: 2 })
    );
    expect(chart.nodes.find((node) => node.id === 'cath_lab_staff')).toEqual(
      expect.objectContaining({ active_staff_count: 2 })
    );

    expect(chart.nodes.some((node) => node.id === 'nursing_incharge')).toBe(false);
    expect(chart.nodes.some((node) => node.id === 'nursing_staff')).toBe(false);
  });
});
