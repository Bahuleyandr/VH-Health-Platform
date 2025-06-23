// src/routes/userRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ userRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'User routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all users with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const role = req.query.role; // Filter by role if provided
    
    let query = 'SELECT id, uid, phone, name, email, role, gender, registered_at FROM users';
    let params = [];
    
    if (role) {
      query += ' WHERE role = $1';
      params.push(role);
    }
    
    query += ' ORDER BY registered_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count for pagination
    const countQuery = role ? 
      'SELECT COUNT(*) FROM users WHERE role = $1' : 
      'SELECT COUNT(*) FROM users';
    const countParams = role ? [role] : [];
    const countResult = await db.query(countQuery, countParams);
    const totalUsers = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Users retrieved successfully',
      users: result.rows,
      pagination: {
        page,
        limit,
        total: totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        hasNext: page * limit < totalUsers,
        hasPrev: page > 1
      },
      filter: role ? { role } : null
    });
  } catch (error) {
    console.log('Database error for users list:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve users',
      error: error.message
    });
  }
});

// Get user by ID or UID
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    
    // Check if identifier is UUID (uid) or number (id)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const column = isUUID ? 'uid' : 'id';
    
    const result = await db.query(
      `SELECT id, uid, phone, name, email, role, gender, address, 
              birthday, anniversary, profile_picture, registered_at 
       FROM users WHERE ${column} = $1`, 
      [identifier]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'User not found',
        identifier,
        searchedBy: column
      });
    }
    
    res.json({
      message: 'User retrieved successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve user',
      error: error.message
    });
  }
});

// Get users by role
router.get('/role/:role', async (req, res) => {
  try {
    const { role } = req.params;
    const validRoles = ['ADMIN', 'DOCTOR', 'NURSE', 'PATIENT', 'PHARMACIST'];
    
    if (!validRoles.includes(role.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid role',
        validRoles
      });
    }
    
    const result = await db.query(
      'SELECT id, uid, phone, name, email, role, registered_at FROM users WHERE role = $1 ORDER BY name',
      [role.toUpperCase()]
    );
    
    res.json({
      message: `${role} users retrieved successfully`,
      users: result.rows,
      count: result.rows.length,
      role: role.toUpperCase()
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve users by role',
      error: error.message
    });
  }
});

// Create new user
router.post('/create', async (req, res) => {
  try {
    const { phone, name, email, gender, address, birthday, anniversary, role = 'PATIENT' } = req.body;
    
    // Basic validation
    if (!phone || !name) {
      return res.status(400).json({
        message: 'Phone and name are required'
      });
    }
    
    // Check if user already exists
    const existingUser = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        message: 'User with this phone number already exists'
      });
    }
    
    const result = await db.query(
      `INSERT INTO users (phone, name, email, gender, address, birthday, anniversary, role, registered_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) 
       RETURNING id, uid, phone, name, email, role, registered_at`,
      [phone, name, email, gender, address, birthday, anniversary, role.toUpperCase()]
    );
    
    res.status(201).json({
      message: 'User created successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create user',
      error: error.message
    });
  }
});

// Update user
router.put('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { name, email, gender, address, birthday, anniversary } = req.body;
    
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const column = isUUID ? 'uid' : 'id';
    
    const result = await db.query(
      `UPDATE users SET 
       name = COALESCE($1, name),
       email = COALESCE($2, email), 
       gender = COALESCE($3, gender),
       address = COALESCE($4, address),
       birthday = COALESCE($5, birthday),
       anniversary = COALESCE($6, anniversary),
       updated_at = NOW()
       WHERE ${column} = $7
       RETURNING id, uid, phone, name, email, role, updated_at`,
      [name, email, gender, address, birthday, anniversary, identifier]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({
      message: 'User updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update user',
      error: error.message
    });
  }
});

export default router;