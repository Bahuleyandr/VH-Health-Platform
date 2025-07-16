// src/services/investigation/templateService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

export const createTemplate = async (templateData) => {
  const { name, type, tests, description, department_id, created_by } = templateData;
  
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    // Create template
    const templateResult = await client.query(`
      INSERT INTO investigation_templates (name, type, description, department_id, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, type, description, department_id, created_by]);
    
    const template = templateResult.rows[0];
    
    // Insert template tests
    if (tests && tests.length > 0) {
        for (const test of tests) {
          await client.query(`
            INSERT INTO investigation_template_tests 
            (template_id, test_name, test_code, normal_range, unit, cost)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [template.id, test.test_name, test.test_code, test.normal_range, test.unit, test.cost]);
        }
    }
    
    await client.query('COMMIT');
    return template;
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const getTemplates = async (filters = {}) => {
  let query = `
    SELECT t.*, 
           COUNT(tt.id) as test_count,
           d.name as department_name
    FROM investigation_templates t
    LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
    LEFT JOIN departments d ON t.department_id = d.id
    WHERE t.is_active = true
  `;
  
  const params = [];
  
  if (filters.type) {
    query += ` AND t.type = $${params.length + 1}`;
    params.push(filters.type);
  }
  
  if (filters.department_id) {
    query += ` AND t.department_id = $${params.length + 1}`;
    params.push(filters.department_id);
  }
  
  query += ' GROUP BY t.id, d.name ORDER BY t.name';
  
  const result = await db.query(query, params);
  return result.rows;
};

export const applyTemplate = async (templateId, patientId, doctorId, orderedBy) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    // Get template with tests
    const templateResult = await client.query(`
      SELECT t.type, tt.*
      FROM investigation_templates t
      JOIN investigation_template_tests tt ON t.id = tt.template_id
      WHERE t.id = $1 AND t.is_active = true
    `, [templateId]);
    
    if (templateResult.rows.length === 0) {
      throw new Error('Template not found or inactive');
    }
    
    const investigations = [];
    const templateType = templateResult.rows[0].type;
    
    // Create investigations for each test in template
    for (const test of templateResult.rows) {
      const result = await client.query(`
        INSERT INTO investigations (
          patient_id, doctor_id, test_name, test_code, type,
          normal_range, unit, cost, status, requested_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', NOW(), $9)
        RETURNING *
      `, [
        patientId, doctorId, test.test_name, test.test_code,
        templateType, test.normal_range, test.unit,
        test.cost, orderedBy
      ]);
      
      investigations.push(result.rows[0]);
    }
    
    await client.query('COMMIT');
    return investigations;
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// =================================================================
// NEWLY ADDED FUNCTIONS
// =================================================================

/**
 * Retrieves a single template and its associated tests.
 * @param {number} templateId - The ID of the template.
 * @returns {Promise<object|null>} The template object with a tests array, or null if not found.
 */
export const getTemplateById = async (templateId) => {
  try {
    const result = await db.query(`
      SELECT 
        t.id as template_id, t.name, t.type, t.description, t.is_active,
        tt.id as test_id, tt.test_name, tt.test_code, tt.normal_range, tt.unit, tt.cost
      FROM investigation_templates t
      LEFT JOIN investigation_template_tests tt ON t.id = tt.template_id
      WHERE t.id = $1
    `, [templateId]);

    if (result.rows.length === 0) {
      return null;
    }

    const template = {
      id: result.rows[0].template_id,
      name: result.rows[0].name,
      type: result.rows[0].type,
      description: result.rows[0].description,
      is_active: result.rows[0].is_active,
      tests: result.rows
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

    return template;
  } catch (err) {
    logger.error('Get Template By ID Error:', err);
    throw err;
  }
};

/**
 * Updates a template's details and its tests within a transaction.
 * @param {number} templateId - The ID of the template to update.
 * @param {object} templateData - The new data for the template.
 * @returns {Promise<object>} The fully updated template object.
 */
export const updateTemplate = async (templateId, templateData) => {
  const { name, type, tests, description, updated_by } = templateData;
  
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    const templateResult = await client.query(`
      UPDATE investigation_templates
      SET name = $1, type = $2, description = $3, updated_by = $4, updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [name, type, description, updated_by, templateId]);

    if (templateResult.rows.length === 0) {
      throw new Error('Template not found');
    }
    
    await client.query('DELETE FROM investigation_template_tests WHERE template_id = $1', [templateId]);
    
    if (tests && tests.length > 0) {
      for (const test of tests) {
        await client.query(`
          INSERT INTO investigation_template_tests 
          (template_id, test_name, test_code, normal_range, unit, cost)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [templateId, test.test_name, test.test_code, test.normal_range, test.unit, test.cost]);
      }
    }
    
    await client.query('COMMIT');
    return getTemplateById(templateId);

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Update Template Error:', err);
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Deactivates a template (soft delete).
 * @param {number} templateId - The ID of the template to deactivate.
 * @param {string} deactivatedBy - The UID of the user performing the action.
 * @returns {Promise<object|null>} The deactivated template object, or null if not found.
 */
export const deactivateTemplate = async (templateId, deactivatedBy) => {
  try {
    const result = await db.query(`
      UPDATE investigation_templates
      SET is_active = false, updated_by = $1, updated_at = NOW()
      WHERE id = $2 AND is_active = true
      RETURNING *
    `, [deactivatedBy, templateId]);
    
    return result.rows[0] || null;

  } catch (err) {
    logger.error('Deactivate Template Error:', err);
    throw err;
  }
};