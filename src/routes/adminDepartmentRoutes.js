// src/routes/adminDepartmentRoutes.js - COMPLETE VERSION with SECURITY FIXES

import express from 'express';
import db from '../config/database.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();
console.log('✅ adminDepartmentRoutes loaded');

/**
 * ✅ Admin-only Department Management with Advanced Features
 * Secured with RBAC, comprehensive department operations
 */
wrapAutoRBAC(
  router,
  'adminDepartmentRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          res.json({ 
            message: 'Admin department routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.role || 'anonymous'
          });
        }
      ],

      // Get comprehensive department overview
      [
        '/overview',
        async (req, res) => {
          try {
            const [departmentStats, performanceMetrics, staffDistribution] = await Promise.all([
              // Department statistics
              db.query(`
                SELECT d.id, d.name, d.description, d.is_active, d.location,
                       d.contact_number, d.created_at,
                       u.name as head_doctor_name,
                       COUNT(doc.user_id) as doctor_count,
                       COUNT(s.user_id) as staff_count,
                       COUNT(CASE WHEN doc.is_available = true THEN 1 END) as available_doctors
                FROM departments d
                LEFT JOIN users u ON d.head_doctor_id = u.id
                LEFT JOIN doctors doc ON doc.department = d.name
                LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
                WHERE d.is_active = true
                GROUP BY d.id, d.name, d.description, d.is_active, d.location, 
                         d.contact_number, d.created_at, u.name
                ORDER BY d.name
              `),
              
              // Performance metrics (last 30 days)
              db.query(`
                SELECT doc.department,
                       COUNT(a.id) as total_appointments,
                       COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                       COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                       AVG(doc.consultation_fee) as avg_consultation_fee,
                       SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as revenue
                FROM doctors doc
                LEFT JOIN appointments a ON doc.user_id = a.doctor_id 
                  AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY doc.department
                ORDER BY total_appointments DESC
              `),
              
              // Staff distribution
              db.query(`
                SELECT s.department, u.role, COUNT(*) as count
                FROM staff s
                JOIN users u ON s.user_id = u.id
                WHERE s.is_active = true
                GROUP BY s.department, u.role
                ORDER BY s.department, u.role
              `)
            ]);
            
            res.json({
              message: 'Department overview retrieved successfully',
              overview: {
                departments: departmentStats.rows,
                performance_metrics: performanceMetrics.rows,
                staff_distribution: staffDistribution.rows
              },
              summary: {
                total_departments: departmentStats.rows.length,
                total_doctors: departmentStats.rows.reduce((sum, dept) => sum + parseInt(dept.doctor_count || 0), 0),
                total_staff: departmentStats.rows.reduce((sum, dept) => sum + parseInt(dept.staff_count || 0), 0)
              },
              generated_at: new Date().toISOString()
            });
          } catch (error) {
            logger.error('Database error for department overview:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve department overview',
              error: error.message,
              suggestion: 'Ensure departments, doctors, and staff tables exist with proper relationships'
            });
          }
        }
      ],

      // Get detailed department management data
      [
        '/manage',
        async (req, res) => {
          try {
            const status = req.query.status || 'active'; // active, inactive, all
            const search = req.query.search;
            
            let query = `
              SELECT d.id, d.name, d.description, d.is_active, d.location,
                     d.contact_number, d.created_at, d.updated_at,
                     u.name as head_doctor_name, u.phone as head_doctor_phone,
                     COUNT(doc.user_id) as doctor_count,
                     COUNT(s.user_id) as staff_count,
                     STRING_AGG(DISTINCT doc_users.name, ', ') as doctor_names
              FROM departments d
              LEFT JOIN users u ON d.head_doctor_id = u.id
              LEFT JOIN doctors doc ON doc.department = d.name
              LEFT JOIN users doc_users ON doc.user_id = doc_users.id
              LEFT JOIN staff s ON s.department = d.name AND s.is_active = true
              WHERE 1=1
            `;
            let params = [];
            
            if (status === 'active') {
              query += ' AND d.is_active = true';
            } else if (status === 'inactive') {
              query += ' AND d.is_active = false';
            }
            
            if (search) {
              query += ` AND (d.name ILIKE $${params.length + 1} OR d.description ILIKE $${params.length + 1})`;
              params.push(`%${search}%`);
            }
            
            query += ` GROUP BY d.id, d.name, d.description, d.is_active, d.location,
                       d.contact_number, d.created_at, d.updated_at, u.name, u.phone
                       ORDER BY d.name`;
            
            const result = await db.query(query, params);
            
            res.json({
              message: 'Department management data retrieved successfully',
              departments: result.rows,
              count: result.rows.length,
              filters: {
                status: status,
                search: search || null
              }
            });
          } catch (error) {
            logger.error('Database error for department management:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve department management data',
              error: error.message
            });
          }
        }
      ],

      // Get department financial overview
      [
        '/:id/financial',
        async (req, res) => {
          try {
            const { id } = req.params;
            const months = parseInt(req.query.months) || 6;
            
            // Get department info
            const deptInfo = await db.query('SELECT name, budget FROM departments WHERE id = $1', [id]);
            if (deptInfo.rows.length === 0) {
              return res.status(404).json({ message: 'Department not found' });
            }
            
            const departmentName = deptInfo.rows[0].name;
            
            const [revenueData, expenseData, profitability] = await Promise.all([
              // Revenue from consultations and procedures
              db.query(`
                SELECT DATE_TRUNC('month', a.appointment_date) as month,
                       SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as consultation_revenue,
                       COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments
                FROM appointments a
                JOIN users d ON a.doctor_id = d.id
                JOIN doctors doc ON d.id = doc.user_id
                WHERE doc.department = $1 
                  AND a.appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
                GROUP BY DATE_TRUNC('month', a.appointment_date)
                ORDER BY month DESC
              `, [departmentName]),
              
              // Estimated expenses (staff salaries)
              db.query(`
                SELECT DATE_TRUNC('month', CURRENT_DATE) as month,
                       SUM(s.salary) as estimated_monthly_salary_expense,
                       COUNT(*) as staff_count
                FROM staff s
                WHERE s.department = $1 AND s.is_active = true
                GROUP BY DATE_TRUNC('month', CURRENT_DATE)
              `, [departmentName]),
              
              // Department profitability metrics
              db.query(`
                SELECT 
                  AVG(doc.consultation_fee) as avg_consultation_fee,
                  COUNT(DISTINCT doc.user_id) as total_doctors,
                  COUNT(DISTINCT s.user_id) as total_staff,
                  AVG(s.salary) as avg_staff_salary
                FROM doctors doc
                LEFT JOIN staff s ON s.department = doc.department AND s.is_active = true
                WHERE doc.department = $1 AND doc.is_available = true
              `, [departmentName])
            ]);
            
            res.json({
              message: 'Department financial overview retrieved successfully',
              department: {
                name: departmentName,
                budget: deptInfo.rows[0].budget
              },
              financial_data: {
                monthly_revenue: revenueData.rows,
                monthly_expenses: expenseData.rows,
                profitability_metrics: profitability.rows[0]
              },
              period_months: months,
              generated_at: new Date().toISOString()
            });
          } catch (error) {
            logger.error('Database error for department financial data:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve department financial data',
              error: error.message
            });
          }
        }
      ],

      // Get department staff allocation
      [
        '/:id/staff-allocation',
        async (req, res) => {
          try {
            const { id } = req.params;
            
            // Get department info
            const deptInfo = await db.query('SELECT name FROM departments WHERE id = $1', [id]);
            if (deptInfo.rows.length === 0) {
              return res.status(404).json({ message: 'Department not found' });
            }
            
            const departmentName = deptInfo.rows[0].name;
            
            const [doctors, staff, workload] = await Promise.all([
              // Doctors in department
              db.query(`
                SELECT u.id, u.name, u.phone, u.email,
                       doc.specialization, doc.experience_years, doc.consultation_fee,
                       doc.available_days, doc.available_hours, doc.is_available
                FROM users u
                JOIN doctors doc ON u.id = doc.user_id
                WHERE doc.department = $1
                ORDER BY u.name
              `, [departmentName]),
              
              // Other staff in department
              db.query(`
                SELECT u.id, u.name, u.phone, u.role,
                       s.position, s.shift, s.salary, s.hire_date, s.is_active
                FROM users u
                JOIN staff s ON u.id = s.user_id
                WHERE s.department = $1
                ORDER BY u.role, u.name
              `, [departmentName]),
              
              // Workload analysis (last 30 days)
              db.query(`
                SELECT u.name as doctor_name,
                       COUNT(a.id) as total_appointments,
                       COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                       COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                       ROUND(COUNT(a.id)::numeric / 30, 2) as avg_appointments_per_day
                FROM users u
                JOIN doctors doc ON u.id = doc.user_id
                LEFT JOIN appointments a ON u.id = a.doctor_id 
                  AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
                WHERE doc.department = $1
                GROUP BY u.id, u.name
                ORDER BY total_appointments DESC
              `, [departmentName])
            ]);
            
            res.json({
              message: 'Department staff allocation retrieved successfully',
              department: {
                name: departmentName
              },
              allocation: {
                doctors: doctors.rows,
                staff: staff.rows,
                workload_analysis: workload.rows
              },
              summary: {
                total_doctors: doctors.rows.length,
                available_doctors: doctors.rows.filter(d => d.is_available).length,
                total_staff: staff.rows.length,
                active_staff: staff.rows.filter(s => s.is_active).length
              }
            });
          } catch (error) {
            logger.error('Database error for staff allocation:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve staff allocation',
              error: error.message
            });
          }
        }
      ]
    ],

    post: [
      // Create new department (admin only)
      [
        '/create',
        async (req, res) => {
          try {
            const { 
              name, description, head_doctor_id, contact_number, 
              location, budget, is_active = true 
            } = req.body;
            
            if (!name || !description) {
              return res.status(400).json({
                message: 'Name and description are required'
              });
            }
            
            // Check if department already exists
            const existingDept = await db.query('SELECT id FROM departments WHERE name = $1', [name]);
            if (existingDept.rows.length > 0) {
              return res.status(409).json({
                message: 'Department with this name already exists'
              });
            }
            
            // Verify head doctor exists and is available
            if (head_doctor_id) {
              const doctorCheck = await db.query(
                'SELECT id, name FROM users WHERE id = $1 AND role = $2', 
                [head_doctor_id, 'DOCTOR']
              );
              if (doctorCheck.rows.length === 0) {
                return res.status(404).json({ message: 'Head doctor not found or invalid role' });
              }
              
              // Check if doctor is already head of another department
              const existingHead = await db.query(
                'SELECT name FROM departments WHERE head_doctor_id = $1 AND is_active = true', 
                [head_doctor_id]
              );
              if (existingHead.rows.length > 0) {
                return res.status(409).json({
                  message: 'Doctor is already head of another department',
                  existing_department: existingHead.rows[0].name
                });
              }
            }
            
            const result = await db.query(`
              INSERT INTO departments (
                name, description, head_doctor_id, contact_number, 
                location, budget, is_active, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
              RETURNING *
            `, [name, description, head_doctor_id, contact_number, location, budget, is_active]);
            
            res.status(201).json({
              message: 'Department created successfully',
              department: result.rows[0]
            });
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to create department',
              error: error.message
            });
          }
        }
      ],

      // Bulk department operations
      [
        '/bulk-operations',
        async (req, res) => {
          try {
            const { operation, department_ids, data } = req.body;
            
            if (!operation || !department_ids || !Array.isArray(department_ids)) {
              return res.status(400).json({
                message: 'operation and department_ids array are required'
              });
            }
            
            const validOperations = ['activate', 'deactivate', 'update_budget', 'reassign_head'];
            if (!validOperations.includes(operation)) {
              return res.status(400).json({
                message: 'Invalid operation',
                validOperations
              });
            }
            
            let results = [];
            
            switch (operation) {
              case 'activate':
                const activateResult = await db.query(
                  'UPDATE departments SET is_active = true, updated_at = NOW() WHERE id = ANY($1) RETURNING id, name',
                  [department_ids]
                );
                results = activateResult.rows;
                break;
                
              case 'deactivate':
                const deactivateResult = await db.query(
                  'UPDATE departments SET is_active = false, updated_at = NOW() WHERE id = ANY($1) RETURNING id, name',
                  [department_ids]
                );
                results = deactivateResult.rows;
                break;
                
              case 'update_budget':
                if (!data.budget) {
                  return res.status(400).json({ message: 'budget is required for update_budget operation' });
                }
                const budgetResult = await db.query(
                  'UPDATE departments SET budget = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id, name, budget',
                  [data.budget, department_ids]
                );
                results = budgetResult.rows;
                break;
                
              case 'reassign_head':
                if (!data.head_doctor_id) {
                  return res.status(400).json({ message: 'head_doctor_id is required for reassign_head operation' });
                }
                
                // Verify doctor exists
                const doctorCheck = await db.query('SELECT name FROM users WHERE id = $1 AND role = $2', [data.head_doctor_id, 'DOCTOR']);
                if (doctorCheck.rows.length === 0) {
                  return res.status(404).json({ message: 'Head doctor not found' });
                }
                
                const reassignResult = await db.query(
                  'UPDATE departments SET head_doctor_id = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id, name',
                  [data.head_doctor_id, department_ids]
                );
                results = reassignResult.rows;
                break;
            }
            
            res.json({
              message: `Bulk ${operation} operation completed successfully`,
              operation,
              affected_departments: results,
              count: results.length
            });
          } catch (error) {
            logger.error('Database error for bulk operations:', error.message);
            res.status(500).json({
              message: 'Failed to perform bulk operation',
              error: error.message
            });
          }
        }
      ]
    ],

    put: [
      // Update department (admin only)
      [
        '/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { 
              name, description, head_doctor_id, contact_number, 
              location, budget, is_active 
            } = req.body;
            
            // Verify head doctor exists if provided
            if (head_doctor_id) {
              const doctorCheck = await db.query(
                'SELECT id, name FROM users WHERE id = $1 AND role = $2', 
                [head_doctor_id, 'DOCTOR']
              );
              if (doctorCheck.rows.length === 0) {
                return res.status(404).json({ message: 'Head doctor not found or invalid role' });
              }
              
              // Check if doctor is already head of another department (excluding current)
              const existingHead = await db.query(
                'SELECT name FROM departments WHERE head_doctor_id = $1 AND id != $2 AND is_active = true', 
                [head_doctor_id, id]
              );
              if (existingHead.rows.length > 0) {
                return res.status(409).json({
                  message: 'Doctor is already head of another department',
                  existing_department: existingHead.rows[0].name
                });
              }
            }
            
            const result = await db.query(`
              UPDATE departments SET 
                name = COALESCE($1, name),
                description = COALESCE($2, description),
                head_doctor_id = COALESCE($3, head_doctor_id),
                contact_number = COALESCE($4, contact_number),
                location = COALESCE($5, location),
                budget = COALESCE($6, budget),
                is_active = COALESCE($7, is_active),
                updated_at = NOW()
              WHERE id = $8
              RETURNING *
            `, [name, description, head_doctor_id, contact_number, location, budget, is_active, id]);
            
            if (result.rows.length === 0) {
              return res.status(404).json({ message: 'Department not found' });
            }
            
            res.json({
              message: 'Department updated successfully',
              department: result.rows[0]
            });
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to update department',
              error: error.message
            });
          }
        }
      ],

      // Deactivate department (soft delete)
      [
        '/:id/deactivate',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { reason, reassign_to_department } = req.body;
            
            // Get department info
            const deptCheck = await db.query('SELECT name, is_active FROM departments WHERE id = $1', [id]);
            if (deptCheck.rows.length === 0) {
              return res.status(404).json({ message: 'Department not found' });
            }
            
            if (!deptCheck.rows[0].is_active) {
              return res.status(400).json({ message: 'Department is already inactive' });
            }
            
            // Check if there are active doctors/staff in this department
            const [activeDoctors, activeStaff] = await Promise.all([
              db.query('SELECT COUNT(*) as count FROM doctors WHERE department = $1 AND is_available = true', [deptCheck.rows[0].name]),
              db.query('SELECT COUNT(*) as count FROM staff WHERE department = $1 AND is_active = true', [deptCheck.rows[0].name])
            ]);
            
            const doctorCount = parseInt(activeDoctors.rows[0].count);
            const staffCount = parseInt(activeStaff.rows[0].count);
            
            if ((doctorCount > 0 || staffCount > 0) && !reassign_to_department) {
              return res.status(400).json({
                message: 'Cannot deactivate department with active staff',
                active_doctors: doctorCount,
                active_staff: staffCount,
                suggestion: 'Provide reassign_to_department or deactivate staff first'
              });
            }
            
            // Reassign staff if requested
            if (reassign_to_department && (doctorCount > 0 || staffCount > 0)) {
              const targetDept = await db.query('SELECT name FROM departments WHERE id = $1 AND is_active = true', [reassign_to_department]);
              if (targetDept.rows.length === 0) {
                return res.status(404).json({ message: 'Target department for reassignment not found' });
              }
              
              // Reassign doctors and staff
              await Promise.all([
                db.query('UPDATE doctors SET department = $1 WHERE department = $2 AND is_available = true', [targetDept.rows[0].name, deptCheck.rows[0].name]),
                db.query('UPDATE staff SET department = $1 WHERE department = $2 AND is_active = true', [targetDept.rows[0].name, deptCheck.rows[0].name])
              ]);
            }
            
            // Deactivate department
            const result = await db.query(`
              UPDATE departments SET 
                is_active = false,
                head_doctor_id = NULL,
                deactivation_reason = $1,
                updated_at = NOW()
              WHERE id = $2
              RETURNING *
            `, [reason, id]);
            
            res.json({
              message: 'Department deactivated successfully',
              department: result.rows[0],
              reassigned: {
                doctors: reassign_to_department ? doctorCount : 0,
                staff: reassign_to_department ? staffCount : 0,
                to_department: reassign_to_department ? targetDept.rows[0].name : null
              }
            });
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to deactivate department',
              error: error.message
            });
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;