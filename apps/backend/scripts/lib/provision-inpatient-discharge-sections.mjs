const INPATIENT_DISCHARGE_SECTION_DEFINITIONS = Object.freeze([
  Object.freeze({
    section_key: 'patient_guardian_instructions',
    section_title: 'Patient / Guardian Instructions',
    canonical_order: 1,
    default_body: '',
  }),
  Object.freeze({
    section_key: 'escalation_contact',
    section_title: 'Escalation Contact',
    canonical_order: 2,
    default_body: '',
  }),
  Object.freeze({
    section_key: 'required_equipment_home_care',
    section_title: 'Required Equipment / Home Care',
    canonical_order: 3,
    default_body: '',
  }),
  Object.freeze({
    section_key: 'discharge_destination',
    section_title: 'Discharge Destination',
    canonical_order: 4,
    default_body: '',
  }),
  Object.freeze({
    section_key: 'transport_plan',
    section_title: 'Transport Plan',
    canonical_order: 5,
    default_body: '',
  }),
]);

const REQUIRED_SECTIONS_JSON = JSON.stringify(
  INPATIENT_DISCHARGE_SECTION_DEFINITIONS,
);

const PLAN_SQL = `
WITH required_section AS (
  SELECT definition.section_key,
         definition.section_title,
         definition.canonical_order,
         definition.default_body
    FROM jsonb_to_recordset($2::jsonb) AS definition(
      section_key text,
      section_title text,
      canonical_order integer,
      default_body text
    )
),
tenant_template AS (
  SELECT template.id,
         template.sections
    FROM discharge_summary_templates AS template
   WHERE template.tenant_id = $1::uuid
     AND template.active
),
malformed_template AS (
  SELECT template.id
    FROM tenant_template AS template
   WHERE jsonb_typeof(template.sections) <> 'array'
),
template_max_order AS (
  SELECT template.id AS template_id,
         COALESCE(
           MAX(
             CASE
               WHEN section.value ->> 'display_order' ~ '^-?[0-9]+$'
                 THEN (section.value ->> 'display_order')::integer
               ELSE NULL
             END
           ),
           0
         ) AS max_display_order
    FROM tenant_template AS template
    LEFT JOIN LATERAL jsonb_array_elements(
      template.sections
    ) AS section(value) ON TRUE
   WHERE jsonb_typeof(template.sections) = 'array'
   GROUP BY template.id
),
missing_template_section AS (
  SELECT template.id AS template_id,
         required.section_key
    FROM tenant_template AS template
    JOIN template_max_order AS max_order
      ON max_order.template_id = template.id
    CROSS JOIN required_section AS required
   WHERE NOT EXISTS (
     SELECT 1
       FROM jsonb_array_elements(template.sections) AS section(value)
      WHERE LOWER(COALESCE(section.value ->> 'section_key', '')) =
            required.section_key
   )
),
eligible_summary AS (
  SELECT summary.id
    FROM discharge_summaries AS summary
   WHERE summary.tenant_id = $1::uuid
     AND summary.status IN ('draft', 'ready_for_signoff')
     AND summary.signed_at IS NULL
     AND summary.signed_by IS NULL
     AND summary.signed_by_name IS NULL
     AND summary.signed_by_reg IS NULL
),
missing_summary_section AS (
  SELECT summary.id AS discharge_summary_id,
         required.section_key
    FROM eligible_summary AS summary
    CROSS JOIN required_section AS required
   WHERE NOT EXISTS (
     SELECT 1
       FROM discharge_summary_sections AS section
      WHERE section.discharge_summary_id = summary.id
        AND LOWER(section.section_key) = required.section_key
   )
)
SELECT (SELECT COUNT(*) FROM malformed_template) AS malformed_template_count,
       (
         SELECT COUNT(DISTINCT template_id)
           FROM missing_template_section
       ) AS templates_to_update,
       (
         SELECT COUNT(*)
           FROM missing_template_section
       ) AS template_definitions_to_add,
       (
         SELECT COUNT(DISTINCT discharge_summary_id)
           FROM missing_summary_section
       ) AS unsigned_summaries_to_update,
       (
         SELECT COUNT(*)
           FROM missing_summary_section
       ) AS summary_sections_to_add
`;

const APPLY_SQL = `
WITH required_section AS (
  SELECT definition.section_key,
         definition.section_title,
         definition.canonical_order,
         definition.default_body
    FROM jsonb_to_recordset($2::jsonb) AS definition(
      section_key text,
      section_title text,
      canonical_order integer,
      default_body text
    )
),
template_max_order AS (
  SELECT template.id AS template_id,
         COALESCE(
           MAX(
             CASE
               WHEN section.value ->> 'display_order' ~ '^-?[0-9]+$'
                 THEN (section.value ->> 'display_order')::integer
               ELSE NULL
             END
           ),
           0
         ) AS max_display_order
    FROM discharge_summary_templates AS template
    LEFT JOIN LATERAL jsonb_array_elements(
      template.sections
    ) AS section(value) ON TRUE
   WHERE template.tenant_id = $1::uuid
     AND template.active
     AND jsonb_typeof(template.sections) = 'array'
   GROUP BY template.id
),
missing_template_section AS (
  SELECT template.id AS template_id,
         required.section_key,
         required.section_title,
         required.default_body,
         max_order.max_display_order,
         ROW_NUMBER() OVER (
           PARTITION BY template.id
           ORDER BY required.canonical_order
         ) AS append_offset
    FROM discharge_summary_templates AS template
    JOIN template_max_order AS max_order
      ON max_order.template_id = template.id
    CROSS JOIN required_section AS required
   WHERE template.tenant_id = $1::uuid
     AND template.active
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(template.sections) AS section(value)
        WHERE LOWER(COALESCE(section.value ->> 'section_key', '')) =
              required.section_key
     )
),
template_addition AS (
  SELECT missing.template_id,
         jsonb_agg(
           jsonb_build_object(
             'section_key',
             missing.section_key,
             'section_title',
             missing.section_title,
             'display_order',
             missing.max_display_order + missing.append_offset,
             'default_body',
             missing.default_body
           )
           ORDER BY missing.append_offset
         ) AS definitions
    FROM missing_template_section AS missing
   GROUP BY missing.template_id
),
updated_template AS (
  UPDATE discharge_summary_templates AS template
     SET sections = template.sections || addition.definitions,
         updated_at = NOW()
    FROM template_addition AS addition
   WHERE template.tenant_id = $1::uuid
     AND template.id = addition.template_id
  RETURNING template.id
),
summary_max_order AS (
  SELECT summary.id AS discharge_summary_id,
         summary.tenant_id,
         COALESCE(MAX(section.display_order), 0) AS max_display_order
    FROM discharge_summaries AS summary
    LEFT JOIN discharge_summary_sections AS section
      ON section.discharge_summary_id = summary.id
   WHERE summary.tenant_id = $1::uuid
     AND summary.status IN ('draft', 'ready_for_signoff')
     AND summary.signed_at IS NULL
     AND summary.signed_by IS NULL
     AND summary.signed_by_name IS NULL
     AND summary.signed_by_reg IS NULL
   GROUP BY summary.id, summary.tenant_id
),
missing_summary_section AS (
  SELECT summary.discharge_summary_id,
         summary.tenant_id,
         required.section_key,
         required.section_title,
         summary.max_display_order,
         ROW_NUMBER() OVER (
           PARTITION BY summary.discharge_summary_id
           ORDER BY required.canonical_order
         ) AS append_offset
    FROM summary_max_order AS summary
    CROSS JOIN required_section AS required
   WHERE NOT EXISTS (
     SELECT 1
       FROM discharge_summary_sections AS section
      WHERE section.discharge_summary_id = summary.discharge_summary_id
        AND LOWER(section.section_key) = required.section_key
   )
),
inserted_summary_section AS (
  INSERT INTO discharge_summary_sections (
    discharge_summary_id,
    section_key,
    section_title,
    display_order,
    body,
    tenant_id
  )
  SELECT missing.discharge_summary_id,
         missing.section_key,
         missing.section_title,
         missing.max_display_order + missing.append_offset,
         NULL,
         missing.tenant_id
    FROM missing_summary_section AS missing
  ON CONFLICT (discharge_summary_id, section_key) DO NOTHING
  RETURNING discharge_summary_id
)
SELECT (SELECT COUNT(*) FROM updated_template) AS templates_updated,
       (
         SELECT COUNT(*)
           FROM missing_template_section
       ) AS template_definitions_added,
       (
         SELECT COUNT(DISTINCT discharge_summary_id)
           FROM inserted_summary_section
       ) AS unsigned_summaries_updated,
       (
         SELECT COUNT(*)
           FROM inserted_summary_section
       ) AS summary_sections_added
`;

function count(value) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizePlan(row = {}) {
  return Object.freeze({
    required_section_count: INPATIENT_DISCHARGE_SECTION_DEFINITIONS.length,
    templates_to_update: count(row.templates_to_update),
    template_definitions_to_add: count(row.template_definitions_to_add),
    unsigned_summaries_to_update: count(row.unsigned_summaries_to_update),
    summary_sections_to_add: count(row.summary_sections_to_add),
  });
}

function normalizeApplied(row = {}) {
  return Object.freeze({
    required_section_count: INPATIENT_DISCHARGE_SECTION_DEFINITIONS.length,
    templates_updated: count(row.templates_updated),
    template_definitions_added: count(row.template_definitions_added),
    unsigned_summaries_updated: count(row.unsigned_summaries_updated),
    summary_sections_added: count(row.summary_sections_added),
  });
}

function requireClient(client) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('A connected PostgreSQL transaction client is required');
  }
}

export async function planInpatientDischargeSectionProvisioning(
  client,
  { tenantId } = {},
) {
  requireClient(client);
  const result = await client.query(
    PLAN_SQL,
    [tenantId, REQUIRED_SECTIONS_JSON],
  );
  const row = result.rows[0] || {};
  if (count(row.malformed_template_count) > 0) {
    throw new Error(
      'Active discharge-summary templates must contain a JSON section array before inpatient shadow provisioning',
    );
  }
  return normalizePlan(row);
}

export async function provisionInpatientDischargeSectionsTx(
  client,
  { tenantId } = {},
) {
  requireClient(client);
  await planInpatientDischargeSectionProvisioning(client, { tenantId });
  const result = await client.query(
    APPLY_SQL,
    [tenantId, REQUIRED_SECTIONS_JSON],
  );
  return normalizeApplied(result.rows[0]);
}

export const __testing__ = Object.freeze({
  APPLY_SQL,
  INPATIENT_DISCHARGE_SECTION_DEFINITIONS,
  PLAN_SQL,
  REQUIRED_SECTIONS_JSON,
});
