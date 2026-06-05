import fs from 'fs';
import path from 'path';
import {
  getRolePolicyRoleCodes,
  getStaffRosterRoleCodes,
} from '../../config/rolePolicyGraph.js';
import * as routePolicy from '../../config/routeRolePolicy.js';

describe('routeRolePolicy', () => {
  it('only exports role arrays made from canonical policy roles', () => {
    const knownRoles = new Set(getRolePolicyRoleCodes());
    for (const [name, value] of Object.entries(routePolicy)) {
      if (!Array.isArray(value)) continue;
      expect(value.length).toBeGreaterThan(0);
      expect([...new Set(value)].length).toBe(value.length);
      for (const role of value) {
        expect(knownRoles.has(role)).toBe(true);
      }
    }
  });

  it('keeps OP flow separate from generic IP nursing work', () => {
    expect(routePolicy.OP_FLOW_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'RECEPTIONIST',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
      'DOCTOR',
    ]));
    expect(routePolicy.OP_FLOW_ROUTE_ROLES).not.toEqual(expect.arrayContaining([
      'NURSING_STAFF',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'HOUSEKEEPING_STAFF',
    ]));
  });

  it('keeps patient registry writes front-office/billing/records scoped', () => {
    expect(routePolicy.PATIENT_REGISTRY_WRITE_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'RECEPTIONIST',
      'RECEPTION_INCHARGE',
      'ADMISSION_OFFICER',
      'BILLING_STAFF',
      'MEDICAL_RECORDS',
    ]));
    expect(routePolicy.PATIENT_REGISTRY_WRITE_ROUTE_ROLES).not.toEqual(expect.arrayContaining([
      'DOCTOR',
      'NURSING_STAFF',
      'OP_STAFF_NURSE',
      'IP_STAFF_NURSE',
    ]));
  });

  it('keeps bed board visibility wider than bed movement and allocation rights', () => {
    expect(routePolicy.BED_PARENT_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'HOUSEKEEPING_STAFF',
      'HOUSEKEEPING_INCHARGE',
      'RECEPTIONIST',
      'ADMISSION_OFFICER',
    ]));
    expect(routePolicy.BED_ALLOCATION_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'RECEPTIONIST',
      'RECEPTION_INCHARGE',
      'ADMISSION_OFFICER',
      'IPD_COUNSELLOR',
    ]));
    expect(routePolicy.BED_ALLOCATION_ROUTE_ROLES).not.toEqual(expect.arrayContaining([
      'HOUSEKEEPING_STAFF',
      'HOUSEKEEPING_INCHARGE',
    ]));
    expect(routePolicy.BED_CLINICAL_ROUTE_ROLES).not.toEqual(expect.arrayContaining([
      'RECEPTIONIST',
      'RECEPTION_INCHARGE',
      'ADMISSION_OFFICER',
      'IPD_COUNSELLOR',
    ]));
  });

  it('covers OP/IP/OT/Cath/ICU nursing branches without widening NURSING_INCHARGE itself', () => {
    expect(routePolicy.IP_FLOW_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'NURSING_STAFF',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'ICU_NURSE',
      'ICU_INCHARGE',
    ]));
    expect(routePolicy.THEATRE_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'OT_NURSE',
      'OT_INCHARGE',
      'OT_STAFF',
      'ANAESTHETIST',
    ]));
    expect(routePolicy.CATH_LAB_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'CATH_LAB_STAFF',
      'CATH_LAB_INCHARGE',
    ]));
  });

  it('keeps staff messaging open to every canonical staff role', () => {
    expect(routePolicy.ALL_STAFF_MESSAGING_ROUTE_ROLES).toEqual(
      getStaffRosterRoleCodes({ includeAdmin: true }),
    );
    expect(routePolicy.ALL_STAFF_MESSAGING_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'HR_STAFF',
      'PHARMACY_STAFF',
      'HOUSEKEEPING_STAFF',
      'RECEPTIONIST',
      'CATH_LAB_STAFF',
    ]));
  });

  it('keeps clinical AI control on platform and technical administration roles', () => {
    expect(routePolicy.TECHNICAL_ADMIN_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'ADMIN',
      'SUPER_ADMIN',
      'IT_ADMIN',
      'SYSTEM_ADMIN',
      'AI_GOVERNANCE_ADMIN',
    ]));
    expect(routePolicy.TECHNICAL_ADMIN_ROUTE_ROLES).not.toEqual(expect.arrayContaining([
      'DOCTOR',
      'NURSING_STAFF',
      'RECEPTIONIST',
    ]));
  });

  it('keeps stores/purchase authority on supply-chain routes, not dispensing-only route groups', () => {
    expect(routePolicy.PHARMACY_SUPPLY_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'ADMIN',
      'SUPER_ADMIN',
      'PHARMACY_INCHARGE',
      'STORES_PURCHASE_INCHARGE',
    ]));
    expect(routePolicy.PHARMACY_ROUTE_ROLES).not.toContain('STORES_PURCHASE_INCHARGE');
    expect(routePolicy.PHARMACY_ORDER_ROUTE_ROLES).not.toContain('STORES_PURCHASE_INCHARGE');
  });

  it('keeps diagnostic clinical surfaces represented by named route policies', () => {
    expect(routePolicy.RADIOLOGY_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'RADIOLOGY_STAFF',
      'DOCTOR',
      'NURSING_STAFF',
    ]));
    expect(routePolicy.MICROBIOLOGY_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'LAB_STAFF',
      'PATHOLOGIST',
      'DOCTOR',
    ]));
    expect(routePolicy.PCPNDT_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'RADIOLOGY_STAFF',
      'DOCTOR',
      'NURSING_STAFF',
    ]));
    expect(routePolicy.LAB_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'LAB_STAFF',
      'PATHOLOGIST',
      'CATH_LAB_STAFF',
    ]));
  });

  it('keeps Staff app fallback role enum values registered in backend policy', () => {
    const staffRolePath = path.resolve(process.cwd(), '../staff/lib/core/config/role_config.dart');
    const source = fs.readFileSync(staffRolePath, 'utf8');
    const staffEnumValues = [...source.matchAll(/^\s*[a-zA-Z]\w*\('([A-Z0-9_]+)'\),?/gm)]
      .map((match) => match[1]);
    const knownRoles = new Set(getRolePolicyRoleCodes());

    expect(staffEnumValues).toEqual(expect.arrayContaining([
      'OP_STAFF_NURSE',
      'IP_STAFF_NURSE',
      'OT_NURSE',
      'CATH_LAB_STAFF',
      'RECEPTIONIST',
    ]));
    for (const role of staffEnumValues) {
      expect(knownRoles.has(role)).toBe(true);
    }
  });
});
