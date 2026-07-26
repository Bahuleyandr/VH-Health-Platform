import { jest } from '@jest/globals';

import {
  __testing__,
  planInpatientDischargeSectionProvisioning,
  provisionInpatientDischargeSectionsTx,
} from '../../../scripts/lib/provision-inpatient-discharge-sections.mjs';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('inpatient discharge-section shadow provisioning', () => {
  test('dry-run is read-only and reports exact missing work', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          malformed_template_count: '0',
          templates_to_update: '2',
          template_definitions_to_add: '8',
          unsigned_summaries_to_update: '3',
          summary_sections_to_add: '12',
        }],
      }),
    };

    await expect(
      planInpatientDischargeSectionProvisioning(client, {
        tenantId: TENANT_ID,
      }),
    ).resolves.toEqual({
      required_section_count: 5,
      templates_to_update: 2,
      template_definitions_to_add: 8,
      unsigned_summaries_to_update: 3,
      summary_sections_to_add: 12,
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toBe(__testing__.PLAN_SQL);
    expect(client.query.mock.calls[0][1][0]).toBe(TENANT_ID);
    expect(__testing__.PLAN_SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\b/i,
    );
  });

  test('dry-run fails closed on malformed active template sections', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{ malformed_template_count: '1' }],
      }),
    };

    await expect(
      planInpatientDischargeSectionProvisioning(client, {
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow(
      'Active discharge-summary templates must contain a JSON section array',
    );
  });

  test('apply preflights then reports only rows written by the transaction', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            malformed_template_count: '0',
            templates_to_update: '2',
            template_definitions_to_add: '8',
            unsigned_summaries_to_update: '3',
            summary_sections_to_add: '12',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            templates_updated: '2',
            template_definitions_added: '8',
            unsigned_summaries_updated: '3',
            summary_sections_added: '12',
          }],
        }),
    };

    await expect(
      provisionInpatientDischargeSectionsTx(client, {
        tenantId: TENANT_ID,
      }),
    ).resolves.toEqual({
      required_section_count: 5,
      templates_updated: 2,
      template_definitions_added: 8,
      unsigned_summaries_updated: 3,
      summary_sections_added: 12,
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toBe(__testing__.APPLY_SQL);
    expect(client.query.mock.calls[1][1][0]).toBe(TENANT_ID);
  });

  test('apply is tenant-scoped, missing-only, and excludes signed evidence', () => {
    expect(__testing__.INPATIENT_DISCHARGE_SECTION_DEFINITIONS).toEqual([
      {
        section_key: 'patient_guardian_instructions',
        section_title: 'Patient / Guardian Instructions',
        canonical_order: 1,
        default_body: '',
      },
      {
        section_key: 'escalation_contact',
        section_title: 'Escalation Contact',
        canonical_order: 2,
        default_body: '',
      },
      {
        section_key: 'required_equipment_home_care',
        section_title: 'Required Equipment / Home Care',
        canonical_order: 3,
        default_body: '',
      },
      {
        section_key: 'discharge_destination',
        section_title: 'Discharge Destination',
        canonical_order: 4,
        default_body: '',
      },
      {
        section_key: 'transport_plan',
        section_title: 'Transport Plan',
        canonical_order: 5,
        default_body: '',
      },
    ]);
    for (const contract of [
      'template.tenant_id = $1::uuid',
      'template.active',
      "summary.status IN ('draft', 'ready_for_signoff')",
      'summary.signed_at IS NULL',
      'summary.signed_by IS NULL',
      'summary.signed_by_name IS NULL',
      'summary.signed_by_reg IS NULL',
      'missing.max_display_order + missing.append_offset',
      'ON CONFLICT (discharge_summary_id, section_key) DO NOTHING',
    ]) {
      expect(__testing__.APPLY_SQL).toContain(contract);
    }
    expect(__testing__.APPLY_SQL).not.toMatch(
      /UPDATE\s+discharge_summary_sections/i,
    );
  });
});
