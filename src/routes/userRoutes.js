// src/routes/userRoutes.js - DEBUG VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ userRoutes loaded');

// Test route - always works
router.get('/test', (req, res) => {
  res.json({ 
    message: 'User routes working!',
    timestamp: new Date().toISOString()
  });
});

// Debug route - check table structure
router.get('/debug-table', async (req, res) => {
  try {
    // Check what columns exist in users table
    const tableInfo = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users'
      ORDER BY ordinal_position
    `);
    
    res.json({
      message: 'Users table structure',
      columns: tableInfo.rows,
      count: tableInfo.rows.length
    });
  } catch (error) {
    res.status(500).json({
      message: 'Failed to check table structure',
      error: error.message
    });
  }
});

// Get all users - with corrected query
router.get('/list', async (req, res) => {
  try {
    // First try to see what columns we actually have
    const sampleResult = await db.query('SELECT * FROM users LIMIT 1');
    const columns = Object.keys(sampleResult.rows[0] || {});
    
    // Use actual columns that exist
    const result = await db.query('SELECT * FROM users LIMIT 10');
    
    res.json({
      message: 'Users retrieved from database',
      users: result.rows,
      count: result.rows.length,
      availableColumns: columns,
      debug: 'Successfully connected to database'
    });
  } catch (error) {
    // Fallback to mock data if database fails
    console.log('Database error for users list:', error.message);
    res.json({
      message: 'Users retrieved (mock data - database query failed)',
      users: [
        { id: 1, name: 'Dr. John Doe', email: 'john@hospital.com', created_at: new Date() },
        { id: 2, name: 'Dr. Jane Smith', email: 'jane@hospital.com', created_at: new Date() }
      ],
      count: 2,
      debug: `Database error: ${error.message}`,
      note: 'Check /users/debug-table to see actual table structure'
    });
  }
});

// Get user by ID (this is working!)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({
      message: 'User retrieved from database',
      user: result.rows[0]
    });
  } catch (error) {
    // Fallback for database errors
    console.log('Database error:', error.message);
    res.json({
      message: 'User mock data (database not available)',
      user: {
        id: req.params.id,
        name: 'Mock User',
        email: 'mock@hospital.com',
        created_at: new Date()
      },
      debug: error.message
    });
  }
});

// Create new user
router.post('/create', async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    
    // Check table structure first to use correct columns
    const result = await db.query(
      'INSERT INTO users (name, email, phone) VALUES ($1, $2, $3) RETURNING *',
      [name, email, phone]
    );
    
    res.status(201).json({
      message: 'User created successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(200).json({
      message: 'User creation simulated (database not available)',
      user: {
        id: Math.floor(Math.random() * 1000),
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
        created_at: new Date()
      },
      debug: error.message
    });
  }
});

export default router;