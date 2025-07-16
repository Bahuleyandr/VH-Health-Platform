import db from '../../config/database.js';
import { PAGINATION } from '../../config/pharmacyConfig.js';
import logger from '../../logging/logger.js';

export const getAllMedications = async (filters) => {
  const { page, limit, search, category, in_stock } = filters;
  const offset = (page - 1) * limit;

  let query = `
    SELECT m.id, m.name, m.generic_name, m.brand, m.category, 
           m.dosage, m.form, m.price, m.stock_quantity, 
           TO_CHAR(m.expiry_date, 'DD-MM-YYYY') as expiry_date, 
           m.manufacturer, m.prescription_required,
           m.is_active, TO_CHAR(m.created_at, 'DD-MM-YYYY HH24:MI') as created_at
    FROM medications m
    WHERE m.is_active = true
  `;
  const params = [];

  if (search) {
    query += ' AND (m.name ILIKE $' + (params.length + 1) + ' OR m.generic_name ILIKE $' + (params.length + 1) + ')';
    params.push(`%${search}%`);
  }

  if (category) {
    query += ' AND m.category = $' + (params.length + 1);
    params.push(category);
  }

  if (in_stock !== undefined) {
    if (in_stock === 'true') {
      query += ' AND m.stock_quantity > 0';
    } else {
      query += ' AND m.stock_quantity = 0';
    }
  }

  query += ' ORDER BY m.name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(limit, offset);

  const result = await db.query(query, params);

  // Get total count
  let countQuery = 'SELECT COUNT(*) FROM medications m WHERE m.is_active = true';
  const countParams = [];

  if (search) {
    countQuery += ' AND (m.name ILIKE $1 OR m.generic_name ILIKE $1)';
    countParams.push(`%${search}%`);
  }
  if (category) {
    countQuery += ` AND m.category = $${countParams.length + 1}`;
    countParams.push(category);
  }
  if (in_stock === 'true') {
    countQuery += ' AND m.stock_quantity > 0';
  } else if (in_stock === 'false') {
    countQuery += ' AND m.stock_quantity = 0';
  }

  const countResult = await db.query(countQuery, countParams);
  const totalMedications = parseInt(countResult.rows[0].count);

  return {
    medications: result.rows,
    pagination: {
      page,
      limit,
      total: totalMedications,
      totalPages: Math.ceil(totalMedications / limit),
      hasNext: page * limit < totalMedications,
      hasPrev: page > 1
    },
    filters: {
      search: search || null,
      category: category || null,
      in_stock: in_stock || null
    }
  };
};

export const getMedicationById = async (id) => {
  const result = await db.query(`
    SELECT m.*, 
           TO_CHAR(m.expiry_date, 'DD-MM-YYYY') as expiry_date_formatted,
           TO_CHAR(m.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
           CASE 
             WHEN m.expiry_date < CURRENT_DATE THEN 'EXPIRED'
             WHEN m.expiry_date < CURRENT_DATE + INTERVAL '30 days' THEN 'EXPIRING_SOON'
             ELSE 'VALID'
           END as expiry_status,
           CASE 
             WHEN m.stock_quantity = 0 THEN 'OUT_OF_STOCK'
             WHEN m.stock_quantity < 10 THEN 'LOW_STOCK'
             ELSE 'IN_STOCK'
           END as stock_status
    FROM medications m
    WHERE m.id = $1 AND m.is_active = true
  `, [id]);

  return result.rows.length > 0 ? result.rows[0] : null;
};

export const getMedicationsByCategory = async (category, inStockOnly) => {
  let query = `
    SELECT id, name, generic_name, brand, dosage, form, price, 
           stock_quantity, TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, 
           prescription_required
    FROM medications 
    WHERE category = $1 AND is_active = true
  `;
  const params = [category];

  if (inStockOnly) {
    query += ' AND stock_quantity > 0';
  }

  query += ' ORDER BY name';

  const result = await db.query(query, params);

  return {
    medications: result.rows,
    count: result.rows.length,
    category,
    in_stock_only: inStockOnly
  };
};

export const searchMedications = async (searchParams) => {
  const { q, category, prescription_required, min_price, max_price, in_stock_only } = searchParams;

  let query = `
    SELECT id, name, generic_name, brand, category, dosage, 
           form, price, stock_quantity, prescription_required,
           TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date
    FROM medications 
    WHERE is_active = true
  `;
  const params = [];

  if (q) {
    query += ` AND (name ILIKE $${params.length + 1} OR generic_name ILIKE $${params.length + 1} OR brand ILIKE $${params.length + 1})`;
    params.push(`%${q}%`);
  }

  if (category) {
    query += ` AND category = $${params.length + 1}`;
    params.push(category);
  }

  if (prescription_required !== undefined) {
    query += ` AND prescription_required = $${params.length + 1}`;
    params.push(prescription_required === 'true');
  }

  if (min_price) {
    query += ` AND price >= $${params.length + 1}`;
    params.push(min_price);
  }

  if (max_price) {
    query += ` AND price <= $${params.length + 1}`;
    params.push(max_price);
  }

  if (in_stock_only) {
    query += ' AND stock_quantity > 0';
  }

  query += ' ORDER BY name LIMIT 50';

  const result = await db.query(query, params);

  return {
    medications: result.rows,
    count: result.rows.length,
    search_params: {
      query: q || null,
      category: category || null,
      prescription_required: prescription_required || null,
      price_range: {
        min: min_price || null,
        max: max_price || null
      },
      in_stock_only
    }
  };
};

export const createMedication = async (medicationData) => {
  const { 
    name, generic_name, brand, category, dosage, form, 
    price, stock_quantity, expiry_date, manufacturer, 
    prescription_required = false, description, createdBy 
  } = medicationData;

  // Check if exists
  const existingMed = await db.query(
    'SELECT id FROM medications WHERE name = $1 AND generic_name = $2', 
    [name, generic_name]
  );

  if (existingMed.rows.length > 0) {
    return null;
  }

  const result = await db.query(`
    INSERT INTO medications (
      name, generic_name, brand, category, dosage, form, 
      price, stock_quantity, expiry_date, manufacturer, 
      prescription_required, description, is_active, created_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, NOW(), $13)
    RETURNING *
  `, [name, generic_name, brand, category, dosage, form, 
      price, stock_quantity, expiry_date, manufacturer, 
      prescription_required, description, createdBy]);

  logger.info(`Medication created: ${name} by ${createdBy}`);

  return result.rows[0];
};

export const updateMedication = async (id, updateData) => {
  const { 
    name, generic_name, brand, category, dosage, form, 
    price, stock_quantity, expiry_date, manufacturer, 
    prescription_required, description, updatedBy
  } = updateData;

  const result = await db.query(`
    UPDATE medications SET 
      name = COALESCE($1, name),
      generic_name = COALESCE($2, generic_name),
      brand = COALESCE($3, brand),
      category = COALESCE($4, category),
      dosage = COALESCE($5, dosage),
      form = COALESCE($6, form),
      price = COALESCE($7, price),
      stock_quantity = COALESCE($8, stock_quantity),
      expiry_date = COALESCE($9, expiry_date),
      manufacturer = COALESCE($10, manufacturer),
      prescription_required = COALESCE($11, prescription_required),
      description = COALESCE($12, description),
      updated_at = NOW(),
      updated_by = $14
    WHERE id = $13 AND is_active = true
    RETURNING *
  `, [name, generic_name, brand, category, dosage, form, 
      price, stock_quantity, expiry_date, manufacturer, 
      prescription_required, description, id, updatedBy]);

  if (result.rows.length === 0) {
    return null;
  }

  logger.info(`Medication ${id} updated by ${updatedBy}`);

  return result.rows[0];
};

export const deleteMedication = async (id, deletedBy) => {
  const result = await db.query(
    'UPDATE medications SET is_active = false, updated_at = NOW(), updated_by = $2 WHERE id = $1 RETURNING name, generic_name',
    [id, deletedBy]
  );

  if (result.rows.length === 0) {
    return null;
  }

  logger.info(`Medication ${id} soft deleted by ${deletedBy}`);

  return result.rows[0];
};

export const updateStock = async (id, quantity, operation, updatedBy) => {
  let query;
  let params;

  switch (operation) {
    case 'add':
      query = 'UPDATE medications SET stock_quantity = stock_quantity + $1, updated_at = NOW(), updated_by = $3 WHERE id = $2 RETURNING *';
      params = [quantity, id, updatedBy];
      break;
    case 'subtract':
      query = 'UPDATE medications SET stock_quantity = GREATEST(stock_quantity - $1, 0), updated_at = NOW(), updated_by = $3 WHERE id = $2 RETURNING *';
      params = [quantity, id, updatedBy];
      break;
    default: // 'set'
      query = 'UPDATE medications SET stock_quantity = $1, updated_at = NOW(), updated_by = $3 WHERE id = $2 RETURNING *';
      params = [quantity, id, updatedBy];
  }

  const result = await db.query(query, params);

  if (result.rows.length === 0) {
    return null;
  }

  logger.info(`Stock updated for medication ${id}: ${operation} ${quantity} by ${updatedBy}`);

  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    stock_quantity: result.rows[0].stock_quantity,
    operation,
    quantity_changed: quantity
  };
};