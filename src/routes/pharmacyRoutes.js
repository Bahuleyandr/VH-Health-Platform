// src/routes/pharmacyRoutes.js - ENHANCED VERSION WITH FULL RBAC
import express from 'express';
import { validationResult } from 'express-validator';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import * as pharmacyController from '../controllers/pharmacyController.js';
import { pharmacyOrderValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();
console.log('✅ Enhanced pharmacyRoutes loaded');

// ==================== PUBLIC TEST ROUTE ====================
// Public test route (no authentication required)
wrapRoutesWithValidation(
  router,
  [], // No roles = public access
  {
    get: [
      [
        '/test',
        [],
        (req, res) => {
          res.json({ 
            message: 'Enhanced Pharmacy routes working!',
            timestamp: new Date().toLocaleDateString('en-GB'), // dd-MM-YYYY format
            version: '3.0.0-enhanced',
            features: ['RBAC Protection', 'Role-based Access', 'Comprehensive API', 'Audit Logging']
          });
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// ==================== PATIENT ROUTES ====================
// Routes accessible by PATIENT, PHARMACY_STAFF, DOCTOR, NURSING_STAFF, ADMIN
wrapAutoRBAC(router, 'pharmacyRoutes', {
  post: [
    // Place pharmacy order
    [
      '/orders',
      pharmacyOrderValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
        const { order_note, file_key, prescription_id, urgent } = req.body;
        const requestedBy = req.user?.uid || 'system';
        const requestedByRole = req.user?.role || 'unknown';

        if (!phone || !order_note) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            error: 'Phone and order note are required.'
          });
        }

        try {
          const result = await db.query(
            `INSERT INTO pharmacy_orders (phone, order_note, file_key, prescription_id, urgent, status, requested_by, requested_by_role, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, NOW()) RETURNING *`,
            [phone, order_note, file_key || null, prescription_id || null, urgent || false, requestedBy, requestedByRole]
          );
          
          success(res, {
            ...result.rows[0],
            requestedBy,
            requestedByRole
          }, RESPONSE_MESSAGES.ORDER_PLACED);
        } catch (err) {
          logger.error(`[PharmacyOrder] ${err.stack || err.toString()}`);
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      }
    ]
  ],
  get: [
    // Get pharmacy orders by UID
    ['/orders/uid/:uid', pharmacyController.getPharmacyOrdersByUID],
    
    // Get pharmacy orders by phone
    [
      '/orders/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone);
          const { status, limit = 50, offset = 0 } = req.query;
          const requestedBy = req.user?.uid || 'anonymous';
          const userRole = req.user?.role;

          // Role-based access control
          if (userRole === 'PATIENT') {
            // Patients can only see their own orders
            const userPhone = req.user?.phone;
            if (userPhone && normalizePhone(userPhone) !== phone) {
              return res.status(403).json({
                error: 'Access denied: You can only view your own orders'
              });
            }
          }

          let query = 'SELECT * FROM pharmacy_orders WHERE phone = $1';
          let params = [phone];

          if (status) {
            query += ' AND status = $2';
            params.push(status);
          }

          query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
          params.push(parseInt(limit), parseInt(offset));

          const result = await db.query(query, params);
          
          success(res, {
            orders: result.rows,
            requestedBy,
            phone,
            filters: { status, limit, offset }
          }, 'Pharmacy orders fetched successfully');
        } catch (err) {
          logger.error(`[PharmacyOrders] ${err.stack || err.toString()}`);
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      }
    ]
  ]
});

// ==================== PHARMACY STAFF ROUTES ====================
// Routes accessible by PHARMACY_STAFF, DOCTOR, ADMIN
wrapAutoRBAC(router, 'pharmacyStaffRoutes', {
  get: [
    // Get all medications with filtering and pagination
    [
      '/medications',
      async (req, res) => {
        try {
          const page = parseInt(req.query.page) || 1;
          const limit = Math.min(parseInt(req.query.limit) || 20, 100); // Max 100 per page
          const offset = (page - 1) * limit;
          const search = req.query.search;
          const category = req.query.category;
          const in_stock = req.query.in_stock;
          const requestedBy = req.user?.uid || 'anonymous';
          
          let query = `
            SELECT m.id, m.name, m.generic_name, m.brand, m.category, 
                   m.dosage, m.form, m.price, m.stock_quantity, 
                   TO_CHAR(m.expiry_date, 'DD-MM-YYYY') as expiry_date, 
                   m.manufacturer, m.prescription_required,
                   m.is_active, TO_CHAR(m.created_at, 'DD-MM-YYYY HH24:MI') as created_at
            FROM medications m
            WHERE m.is_active = true
          `;
          let params = [];
          
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
          
          // Get total count for pagination
          let countQuery = 'SELECT COUNT(*) FROM medications m WHERE m.is_active = true';
          let countParams = [];
          
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
          
          success(res, {
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
            },
            requestedBy
          }, 'Medications retrieved successfully');
        } catch (error) {
          logger.error(`[Medications] ${error.message}`);
          res.status(500).json({
            message: 'Failed to retrieve medications - medications table may not exist',
            error: error.message,
            suggestion: 'Create medications table with proper schema',
            requestedBy: req.user?.uid
          });
        }
      }
    ],

    // Get medication by ID
    [
      '/medications/:id',
      async (req, res) => {
        try {
          const { id } = req.params;
          const requestedBy = req.user?.uid || 'anonymous';
          
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
          
          if (result.rows.length === 0) {
            return res.status(404).json({ 
              message: 'Medication not found',
              id,
              requestedBy
            });
          }
          
          success(res, {
            medication: result.rows[0],
            requestedBy
          }, 'Medication retrieved successfully');
        } catch (error) {
          logger.error(`[Medication] ${error.message}`);
          error(res, 'Failed to retrieve medication');
        }
      }
    ],

    // Get medications by category
    [
      '/category/:category',
      async (req, res) => {
        try {
          const { category } = req.params;
          const in_stock_only = req.query.in_stock === 'true';
          const requestedBy = req.user?.uid || 'anonymous';
          
          let query = `
            SELECT id, name, generic_name, brand, dosage, form, price, 
                   stock_quantity, TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, 
                   prescription_required
            FROM medications 
            WHERE category = $1 AND is_active = true
          `;
          let params = [category];
          
          if (in_stock_only) {
            query += ' AND stock_quantity > 0';
          }
          
          query += ' ORDER BY name';
          
          const result = await db.query(query, params);
          
          success(res, {
            medications: result.rows,
            count: result.rows.length,
            category,
            in_stock_only,
            requestedBy
          }, `Medications in ${category} category retrieved successfully`);
        } catch (error) {
          logger.error(`[CategoryMedications] ${error.message}`);
          error(res, 'Failed to retrieve medications by category');
        }
      }
    ],

    // Get low stock medications
    [
      '/inventory/low-stock',
      async (req, res) => {
        try {
          const threshold = parseInt(req.query.threshold) || 10;
          const requestedBy = req.user?.uid || 'anonymous';
          
          const result = await db.query(`
            SELECT id, name, generic_name, brand, category, stock_quantity, 
                   price, TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, manufacturer
            FROM medications 
            WHERE stock_quantity <= $1 AND stock_quantity > 0 AND is_active = true
            ORDER BY stock_quantity ASC, expiry_date ASC
          `, [threshold]);
          
          success(res, {
            medications: result.rows,
            count: result.rows.length,
            threshold,
            requestedBy
          }, 'Low stock medications retrieved successfully');
        } catch (error) {
          logger.error(`[LowStock] ${error.message}`);
          error(res, 'Failed to retrieve low stock medications');
        }
      }
    ],

    // Get expired medications
    [
      '/inventory/expired',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';
          
          const result = await db.query(`
            SELECT id, name, generic_name, brand, category, stock_quantity, 
                   TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, manufacturer, price
            FROM medications 
            WHERE expiry_date < CURRENT_DATE AND is_active = true
            ORDER BY expiry_date DESC
          `);
          
          success(res, {
            medications: result.rows,
            count: result.rows.length,
            note: 'These medications should be removed from inventory',
            requestedBy
          }, 'Expired medications retrieved successfully');
        } catch (error) {
          logger.error(`[ExpiredMedications] ${error.message}`);
          error(res, 'Failed to retrieve expired medications');
        }
      }
    ],

    // Get expiring soon medications
    [
      '/inventory/expiring-soon',
      async (req, res) => {
        try {
          const days = parseInt(req.query.days) || 30;
          const requestedBy = req.user?.uid || 'anonymous';
          
          const result = await db.query(`
            SELECT id, name, generic_name, brand, category, stock_quantity, 
                   TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, manufacturer, price,
                   expiry_date - CURRENT_DATE as days_to_expiry
            FROM medications 
            WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${days} days'
              AND is_active = true
            ORDER BY expiry_date ASC
          `);
          
          success(res, {
            medications: result.rows,
            count: result.rows.length,
            expiry_window_days: days,
            requestedBy
          }, 'Expiring medications retrieved successfully');
        } catch (error) {
          logger.error(`[ExpiringSoon] ${error.message}`);
          error(res, 'Failed to retrieve expiring medications');
        }
      }
    ],

    // Get medication categories
    [
      '/categories/list',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';
          
          const result = await db.query(`
            SELECT category, 
                   COUNT(*) as medication_count,
                   SUM(stock_quantity) as total_stock,
                   ROUND(AVG(price), 2) as average_price
            FROM medications 
            WHERE is_active = true
            GROUP BY category
            ORDER BY category
          `);
          
          success(res, {
            categories: result.rows,
            count: result.rows.length,
            requestedBy
          }, 'Medication categories retrieved successfully');
        } catch (error) {
          logger.error(`[Categories] ${error.message}`);
          error(res, 'Failed to retrieve medication categories');
        }
      }
    ],

    // Advanced search medications
    [
      '/search',
      async (req, res) => {
        try {
          const { 
            q, // General search query
            category, 
            prescription_required, 
            min_price, 
            max_price,
            in_stock_only = false 
          } = req.query;
          const requestedBy = req.user?.uid || 'anonymous';
          
          let query = `
            SELECT id, name, generic_name, brand, category, dosage, 
                   form, price, stock_quantity, prescription_required,
                   TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date
            FROM medications 
            WHERE is_active = true
          `;
          let params = [];
          
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
            params.push(parseFloat(min_price));
          }
          
          if (max_price) {
            query += ` AND price <= $${params.length + 1}`;
            params.push(parseFloat(max_price));
          }
          
          if (in_stock_only === 'true') {
            query += ' AND stock_quantity > 0';
          }
          
          query += ' ORDER BY name LIMIT 50';
          
          const result = await db.query(query, params);
          
          success(res, {
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
            },
            requestedBy
          }, 'Medication search completed');
        } catch (error) {
          logger.error(`[MedicationSearch] ${error.message}`);
          error(res, 'Failed to search medications');
        }
      }
    ],

    // Pharmacy inventory summary
    [
      '/inventory/summary',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';
          
          const [totalStats, categoryStats, stockStats] = await Promise.all([
            // Total inventory statistics
            db.query(`
              SELECT 
                COUNT(*) as total_medications,
                SUM(stock_quantity) as total_stock_items,
                ROUND(SUM(stock_quantity * price), 2) as total_inventory_value,
                ROUND(AVG(price), 2) as average_price
              FROM medications 
              WHERE is_active = true
            `),
            
            // Category breakdown
            db.query(`
              SELECT category, COUNT(*) as count
              FROM medications 
              WHERE is_active = true
              GROUP BY category
              ORDER BY count DESC
            `),
            
            // Stock status
            db.query(`
              SELECT 
                COUNT(CASE WHEN stock_quantity = 0 THEN 1 END) as out_of_stock,
                COUNT(CASE WHEN stock_quantity > 0 AND stock_quantity <= 10 THEN 1 END) as low_stock,
                COUNT(CASE WHEN stock_quantity > 10 THEN 1 END) as in_stock,
                COUNT(CASE WHEN expiry_date < CURRENT_DATE THEN 1 END) as expired,
                COUNT(CASE WHEN expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' THEN 1 END) as expiring_soon
              FROM medications 
              WHERE is_active = true
            `)
          ]);
          
          success(res, {
            summary: {
              totals: totalStats.rows[0],
              categories: categoryStats.rows,
              stock_status: stockStats.rows[0]
            },
            timestamp: new Date().toLocaleDateString('en-GB'), // dd-MM-YYYY format
            requestedBy
          }, 'Pharmacy inventory summary retrieved successfully');
        } catch (error) {
          logger.error(`[InventorySummary] ${error.message}`);
          res.status(500).json({
            message: 'Failed to retrieve inventory summary - some tables may not exist',
            error: error.message,
            suggestion: 'Ensure medications table exists with proper schema',
            requestedBy: req.user?.uid
          });
        }
      }
    ]
  ],

  put: [
    // Update order status (pharmacy staff only)
    [
      '/orders/:orderId/status',
      async (req, res) => {
        try {
          const { orderId } = req.params;
          const { status, notes } = req.body;
          const updatedBy = req.user?.uid || 'system';
          const updatedByRole = req.user?.role || 'unknown';

          if (!status) {
            return res.status(400).json({ error: 'Status is required' });
          }

          const validStatuses = ['pending', 'processing', 'ready', 'dispensed', 'cancelled'];
          if (!validStatuses.includes(status)) {
            return res.status(400).json({ 
              error: 'Invalid status',
              validStatuses
            });
          }

          const result = await db.query(
            `UPDATE pharmacy_orders 
             SET status = $1, notes = $2, updated_by = $3, updated_by_role = $4, updated_at = NOW()
             WHERE id = $5 RETURNING *`,
            [status, notes || null, updatedBy, updatedByRole, orderId]
          );

          if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
          }

          success(res, {
            order: result.rows[0],
            updatedBy,
            updatedByRole
          }, 'Order status updated successfully');
        } catch (error) {
          logger.error(`[OrderStatusUpdate] ${error.message}`);
          error(res, 'Failed to update order status');
        }
      }
    ],

    // Update stock quantity
    [
      '/medications/:id/stock',
      async (req, res) => {
        try {
          const { id } = req.params;
          const { quantity, operation = 'set' } = req.body; // 'set', 'add', 'subtract'
          const updatedBy = req.user?.uid || 'system';
          
          if (quantity === undefined || quantity < 0) {
            return res.status(400).json({
              message: 'Valid quantity is required'
            });
          }
          
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
            return res.status(404).json({ message: 'Medication not found' });
          }
          
          success(res, {
            medication: {
              id: result.rows[0].id,
              name: result.rows[0].name,
              stock_quantity: result.rows[0].stock_quantity,
              operation,
              quantity_changed: quantity
            },
            updatedBy
          }, 'Stock quantity updated successfully');
        } catch (error) {
          logger.error(`[StockUpdate] ${error.message}`);
          error(res, 'Failed to update stock quantity');
        }
      }
    ]
  ]
});

// ==================== ADMIN ROUTES ====================
// Routes accessible only by ADMIN
wrapAutoRBAC(router, 'pharmacyAdminRoutes', {
  post: [
    // Create new medication (admin only)
    [
      '/medications',
      async (req, res) => {
        try {
          const { 
            name, generic_name, brand, category, dosage, form, 
            price, stock_quantity, expiry_date, manufacturer, 
            prescription_required = false, description 
          } = req.body;
          const createdBy = req.user?.uid || 'system';
          
          // Validation
          if (!name || !generic_name || !category || !price) {
            return res.status(400).json({
              message: 'name, generic_name, category, and price are required'
            });
          }
          
          // Check if medication already exists
          const existingMed = await db.query(
            'SELECT id FROM medications WHERE name = $1 AND generic_name = $2', 
            [name, generic_name]
          );
          
          if (existingMed.rows.length > 0) {
            return res.status(409).json({
              message: 'Medication with this name and generic name already exists'
            });
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
          
          success(res, {
            medication: result.rows[0],
            createdBy
          }, 'Medication created successfully');
        } catch (error) {
          logger.error(`[CreateMedication] ${error.message}`);
          error(res, 'Failed to create medication');
        }
      }
    ]
  ],

  put: [
    // Update medication (admin only)
    [
      '/medications/:id',
      async (req, res) => {
        try {
          const { id } = req.params;
          const { 
            name, generic_name, brand, category, dosage, form, 
            price, stock_quantity, expiry_date, manufacturer, 
            prescription_required, description 
          } = req.body;
          const updatedBy = req.user?.uid || 'system';
          
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
            return res.status(404).json({ message: 'Medication not found' });
          }
          
          success(res, {
            medication: result.rows[0],
            updatedBy
          }, 'Medication updated successfully');
        } catch (error) {
          logger.error(`[UpdateMedication] ${error.message}`);
          error(res, 'Failed to update medication');
        }
      }
    ]
  ],

  delete: [
    // Soft delete medication (admin only)
    [
      '/medications/:id',
      async (req, res) => {
        try {
          const { id } = req.params;
          const deletedBy = req.user?.uid || 'system';
          
          const result = await db.query(
            'UPDATE medications SET is_active = false, updated_at = NOW(), updated_by = $2 WHERE id = $1 RETURNING name, generic_name',
            [id, deletedBy]
          );
          
          if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Medication not found' });
          }
          
          success(res, {
            deleted_medication: result.rows[0],
            deletedBy,
            note: 'Medication soft deleted (marked as inactive)'
          }, 'Medication deleted successfully');
        } catch (error) {
          logger.error(`[DeleteMedication] ${error.message}`);
          error(res, 'Failed to delete medication');
        }
      }
    ]
  ],

  get: [
    // Get all orders (admin view)
    [
      '/admin/orders',
      async (req, res) => {
        try {
          const { status, limit = 100, offset = 0, urgent_only } = req.query;
          const requestedBy = req.user?.uid || 'anonymous';

          let query = `
            SELECT po.*, 
                   TO_CHAR(po.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
                   u.name as patient_name
            FROM pharmacy_orders po
            LEFT JOIN users u ON po.phone = u.phone
            WHERE 1=1
          `;
          let params = [];

          if (status) {
            query += ' AND po.status = $' + (params.length + 1);
            params.push(status);
          }

          if (urgent_only === 'true') {
            query += ' AND po.urgent = true';
          }

          query += ' ORDER BY po.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
          params.push(parseInt(limit), parseInt(offset));

          const result = await db.query(query, params);

          success(res, {
            orders: result.rows,
            count: result.rows.length,
            filters: { status, limit, offset, urgent_only },
            requestedBy
          }, 'All pharmacy orders retrieved successfully');
        } catch (error) {
          logger.error(`[AdminOrders] ${error.message}`);
          error(res, 'Failed to retrieve pharmacy orders');
        }
      }
    ],

    // Get order analytics
    [
      '/admin/analytics',
      async (req, res) => {
        try {
          const requestedBy = req.user?.uid || 'anonymous';

          const [orderStats, revenueStats, popularMeds] = await Promise.all([
            // Order statistics
            db.query(`
              SELECT 
                COUNT(*) as total_orders,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_orders,
                COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready_orders,
                COUNT(CASE WHEN status = 'dispensed' THEN 1 END) as dispensed_orders,
                COUNT(CASE WHEN urgent = true THEN 1 END) as urgent_orders
              FROM pharmacy_orders
              WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
            `),

            // Revenue statistics (if order values are tracked)
            db.query(`
              SELECT 
                TO_CHAR(created_at, 'DD-MM-YYYY') as order_date,
                COUNT(*) as orders_count
              FROM pharmacy_orders
              WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
              GROUP BY TO_CHAR(created_at, 'DD-MM-YYYY')
              ORDER BY order_date DESC
            `),

            // Most requested medications (mock data)
            db.query(`
              SELECT category, COUNT(*) as request_count
              FROM pharmacy_orders po
              JOIN medications m ON po.order_note ILIKE '%' || m.name || '%'
              WHERE po.created_at >= CURRENT_DATE - INTERVAL '30 days'
              GROUP BY category
              ORDER BY request_count DESC
              LIMIT 10
            `).catch(() => ({ rows: [] })) // Fallback if join fails
          ]);

          success(res, {
            analytics: {
              order_statistics: orderStats.rows[0],
              weekly_trends: revenueStats.rows,
              popular_categories: popularMeds.rows
            },
            period: 'Last 30 days',
            requestedBy
          }, 'Pharmacy analytics retrieved successfully');
        } catch (error) {
          logger.error(`[PharmacyAnalytics] ${error.message}`);
          res.status(500).json({
            message: 'Failed to retrieve pharmacy analytics',
            error: error.message,
            requestedBy: req.user?.uid
          });
        }
      }
    ]
  ]
});

export default router;