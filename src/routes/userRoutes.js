// src/routes/userRoutes.js - UPDATED WITH SAFE DATABASE
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

// Get all users - with database fallback
router.get('/list', async (req, res) => {
  try {
    // Try database first
    const result = await db.query('SELECT id, name, email, created_at FROM users LIMIT 10');
    res.json({
      message: 'Users retrieved from database',
      users: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    // Fallback to mock data if database fails
    console.log('Database not available, using mock data:', error.message);
    res.json({
      message: 'Users retrieved (mock data - database not available)',
      users: [
        { id: 1, name: 'Dr. John Doe', email: 'john@hospital.com', created_at: new Date() },
        { id: 2, name: 'Dr. Jane Smith', email: 'jane@hospital.com', created_at: new Date() }
      ],
      count: 2,
      debug: 'Database connection failed, showing mock data'
    });
  }
});

// Get user by ID
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
    
    const result = await db.query(
      'INSERT INTO users (name, email, phone, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
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