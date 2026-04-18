// src/services/investigation/templateService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export const createTemplate = async (templateData) => {
  const { name, type, tests, description, department_id, created_by } = templateData;

  const [templateRows] = await prisma.$queryRaw`
    INSERT INTO investigation_templates (name, type, description, department_id, created_by)
    VALUES (${name}, ${type}, ${description ?? null}, ${department_id ?? null}, ${created_by ?? null})
    RETURNING id, name, type, description, department_id, is_active, created_by, created_at
  `;

  if (tests && tests.length > 0) {
    for (const test of tests) {
      await prisma.$queryRaw`
        INSERT INTO investigation_template_tests
          (template_id, test_name, test_code, normal_range, unit, cost)
        VALUES (
          ${templateRows.id}, ${test.test_name}, ${test.test_code ?? null},
          ${test.normal_range ?? null}, ${test.unit ?? null}, ${test.cost ?? null}
        )
      `;
    }
  }

  return templateRows;
};

export const getTemplates = async (filters = {}) => {
  const { type, department_id } = filters;

  // Use $queryRaw for the GROUP BY + JOIN query
  if (type && department_id) {
    return prisma.$queryRaw`
      SELECT t.*, COUNT(tt.id)::int as test_count, d.name as department_name
      FROM investigation_templates t
      LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
      LEFT JOIN departments d ON t.department_id = d.id
      WHERE t.is_active = true AND t.type = ${type} AND t.department_id = ${parseInt(department_id)}
      GROUP BY t.id, d.name ORDER BY t.name
    `;
  } else if (type) {
    return prisma.$queryRaw`
      SELECT t.*, COUNT(tt.id)::int as test_count, d.name as department_name
      FROM investigation_templates t
      LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
      LEFT JOIN departments d ON t.department_id = d.id
      WHERE t.is_active = true AND t.type = ${type}
      GROUP BY t.id, d.name ORDER BY t.name
    `;
  } else if (department_id) {
    return prisma.$queryRaw`
      SELECT t.*, COUNT(tt.id)::int as test_count, d.name as department_name
      FROM investigation_templates t
      LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
      LEFT JOIN departments d ON t.department_id = d.id
      WHERE t.is_active = true AND t.department_id = ${parseInt(department_id)}
      GROUP BY t.id, d.name ORDER BY t.name
    `;
  } else {
    return prisma.$queryRaw`
      SELECT t.*, COUNT(tt.id)::int as test_count, d.name as department_name
      FROM investigation_templates t
      LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
      LEFT JOIN departments d ON t.department_id = d.id
      WHERE t.is_active = true
      GROUP BY t.id, d.name ORDER BY t.name
    `;
  }
};

export const applyTemplate = async (templateId, patientId, doctorId, orderedBy) => {
  const templateRows = await prisma.$queryRaw`
    SELECT t.type, tt.*
    FROM investigation_templates t
    JOIN investigation_template_tests tt ON t.id = tt.template_id
    WHERE t.id = ${parseInt(templateId)} AND t.is_active = true
  `;

  if (templateRows.length === 0) {
    throw new Error('Template not found or inactive');
  }

  const templateType = templateRows[0].type;
  const investigations = [];

  for (const test of templateRows) {
    const [inv] = await prisma.$queryRaw`
      INSERT INTO investigations (
        patient_id, doctor_id, test_name, test_code, type,
        normal_range, unit, cost, status, requested_at, created_by
      ) VALUES (
        ${parseInt(patientId)}, ${parseInt(doctorId)},
        ${test.test_name}, ${test.test_code ?? null}, ${templateType},
        ${test.normal_range ?? null}, ${test.unit ?? null}, ${test.cost ?? null},
        'PENDING', NOW(), ${orderedBy ?? null}
      )
      RETURNING id, patient_id, doctor_id, test_name, test_code, type,
        normal_range, unit, cost, status, requested_at, created_by
    `;
    investigations.push(inv);
  }

  return investigations;
};

export const getTemplateById = async (templateId) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        t.id as template_id, t.name, t.type, t.description, t.is_active,
        tt.id as test_id, tt.test_name, tt.test_code, tt.normal_range, tt.unit, tt.cost
      FROM investigation_templates t
      LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
      WHERE t.id = ${parseInt(templateId)}
    `;

    if (rows.length === 0) return null;

    return {
      id: rows[0].template_id,
      name: rows[0].name,
      type: rows[0].type,
      description: rows[0].description,
      is_active: rows[0].is_active,
      tests: rows
        .filter(row => row.test_id)
        .map(row => ({
          id: row.test_id,
          test_name: row.test_name,
          test_code: row.test_code,
          normal_range: row.normal_range,
          unit: row.unit,
          cost: row.cost,
        })),
    };
  } catch (err) {
    logger.error('Get Template By ID Error:', err);
    throw err;
  }
};

export const updateTemplate = async (templateId, templateData) => {
  const { name, type, tests, description, updated_by } = templateData;

  try {
    const templateRows = await prisma.$queryRaw`
      UPDATE investigation_templates
      SET name = ${name}, type = ${type}, description = ${description ?? null},
          updated_by = ${updated_by ?? null}, updated_at = NOW()
      WHERE id = ${parseInt(templateId)}
      RETURNING id, name, type, description, department_id, is_active, updated_by, updated_at, created_at
    `;

    if (templateRows.length === 0) throw new Error('Template not found');

    await prisma.$queryRaw`
      DELETE FROM investigation_template_tests WHERE template_id = ${parseInt(templateId)}
    `;

    if (tests && tests.length > 0) {
      for (const test of tests) {
        await prisma.$queryRaw`
          INSERT INTO investigation_template_tests
            (template_id, test_name, test_code, normal_range, unit, cost)
          VALUES (
            ${parseInt(templateId)}, ${test.test_name}, ${test.test_code ?? null},
            ${test.normal_range ?? null}, ${test.unit ?? null}, ${test.cost ?? null}
          )
        `;
      }
    }

    return getTemplateById(templateId);
  } catch (err) {
    logger.error('Update Template Error:', err);
    throw err;
  }
};

export const deactivateTemplate = async (templateId, deactivatedBy) => {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE investigation_templates
      SET is_active = false, updated_by = ${deactivatedBy ?? null}, updated_at = NOW()
      WHERE id = ${parseInt(templateId)} AND is_active = true
      RETURNING id, name, type, description, department_id, is_active, updated_by, updated_at, created_at
    `;
    return rows[0] || null;
  } catch (err) {
    logger.error('Deactivate Template Error:', err);
    throw err;
  }
};
