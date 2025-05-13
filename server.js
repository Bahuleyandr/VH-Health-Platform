// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// API Key Protection
const API_KEY = process.env.API_KEY || 'vhhealth123';
app.use((req, res, next) => {
  const clientKey = req.headers['x-api-key'];
  if (clientKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }
  next();
});

// Health Check
app.get('/', (req, res) => {
  res.json({ message: 'VH Health API is running.' });
});

// Existing Features Remain Unchanged...

// Mock Send OTP
app.get('/api/send-otp', (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }
  res.json({ message: `Mock OTP sent to ${phone}` });
});

// Request OTP (Mock)
app.post('/api/request-otp', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required.' });
  const otp = '123456';
  res.json({ message: `Mock OTP ${otp} sent to ${phoneNumber}` });
});

// Verify OTP (Mock)
app.post('/api/verify-otp', (req, res) => {
  const { phoneNumber, otp } = req.body;
  if (otp === '123456') {
    res.json({ success: true, message: 'OTP verified successfully.' });
  } else {
    res.status(400).json({ success: false, message: 'Incorrect OTP.' });
  }
});

// Profile Management
app.post('/api/users', async (req, res) => {
  const { phoneNumber, name, gender, address, email, birthday, anniversary, profilePicture } = req.body;
  if (!phoneNumber || !name || !gender) {
    return res.status(400).json({ error: 'Phone number, name, and gender are required.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (phone, name, gender, address, email, birthday, anniversary, profile_picture, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         gender = EXCLUDED.gender,
         address = EXCLUDED.address,
         email = EXCLUDED.email,
         birthday = EXCLUDED.birthday,
         anniversary = EXCLUDED.anniversary,
         profile_picture = EXCLUDED.profile_picture
       RETURNING *`,
      [phoneNumber, name, gender, address, email, birthday, anniversary, profilePicture]
    );
    res.json({ message: 'User profile saved successfully.', user: result.rows[0] });
  } catch (error) {
  console.error('Error Details:', error);
  res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
    if (result.rows.length > 0) {
      res.json({ exists: true, user: result.rows[0] });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get All Users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Book Appointment
app.post('/api/appointments', async (req, res) => {
  const { phone, doctor_name, date, time } = req.body;
  if (!phone || !doctor_name || !date || !time) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone, doctor_name, date, time]
    );
    res.json({ message: 'Appointment booked successfully.', appointment: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get Appointments by Phone Number
app.get('/api/appointments/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query('SELECT * FROM appointments WHERE phone = $1', [phone]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add Health Record
app.post('/api/health-records', async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO health_records (phone, file_name, file_type) VALUES ($1, $2, $3) RETURNING *',
      [phone, file_name, file_type]
    );
    res.json({ message: 'Health record added successfully.', record: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get Health Records by Phone Number
app.get('/api/health-records/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query('SELECT * FROM health_records WHERE phone = $1', [phone]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add Investigation Request
app.post('/api/investigations', async (req, res) => {
  const { phone, test_name } = req.body;
  if (!phone || !test_name) {
    return res.status(400).json({ error: 'Phone number and test name are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO investigations (phone, test_name) VALUES ($1, $2) RETURNING *',
      [phone, test_name]
    );
    res.json({ message: 'Investigation requested successfully.', investigation: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get Investigations by Phone Number
app.get('/api/investigations/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query('SELECT * FROM investigations WHERE phone = $1', [phone]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Place Pharmacy Order
app.post('/api/pharmacy-orders', async (req, res) => {
  const { phone, order_note } = req.body;
  if (!phone || !order_note) {
    return res.status(400).json({ error: 'Phone number and order note are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO pharmacy_orders (phone, order_note) VALUES ($1, $2) RETURNING *',
      [phone, order_note]
    );
    res.json({ message: 'Pharmacy order placed successfully.', order: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get Pharmacy Orders by Phone Number
app.get('/api/pharmacy-orders/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query('SELECT * FROM pharmacy_orders WHERE phone = $1', [phone]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Submit Feedback
app.post('/api/feedback', (req, res) => {
  const { phoneNumber, rating, comment } = req.body;
  if (!phoneNumber || !rating) {
    return res.status(400).json({ error: 'Phone number and rating required.' });
  }
  res.json({ success: true, message: 'Feedback submitted successfully.' });
});

// App Version
app.get('/api/app-version', (req, res) => {
  res.json({ version: '1.0.0', updated_at: '2025-05-12' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
