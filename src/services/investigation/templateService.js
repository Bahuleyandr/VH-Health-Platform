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
    for (const test of tests) {
      await client.query(`
        INSERT INTO investigation_template_tests 
        (template_id, test_name, test_code, normal_range, unit, cost)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [template.id, test.test_name, test.test_code, test.normal_range, test.unit, test.cost]);
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
      SELECT t.*, tt.*
      FROM investigation_templates t
      JOIN investigation_template_tests tt ON t.id = tt.template_id
      WHERE t.id = $1 AND t.is_active = true
    `, [templateId]);
    
    if (templateResult.rows.length === 0) {
      throw new Error('Template not found or inactive');
    }
    
    const investigations = [];
    
    // Create investigations for each test in template
    for (const test of templateResult.rows) {
      const result = await client.query(`
        INSERT INTO investigations (
          patient_id, doctor_id, test_name, test_code, type,
          normal_range, unit, cost, status, ordered_date, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', NOW(), $9)
        RETURNING *
      `, [
        patientId, doctorId, test.test_name, test.test_code,
        templateResult.rows[0].type, test.normal_range, test.unit,
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