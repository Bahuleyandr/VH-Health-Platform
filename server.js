const express = require('express');
const cors = require('cors');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const pool = require('./db');

if (!process.env.API_KEY || !process.env.DATABASE_URL) {
  console.error('Missing required environment variables. Exiting.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Rate Limiting
app.use(rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
}));

// API Key Middleware
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Swagger Setup
const swaggerDocument = YAML.load('./swagger.yaml');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Utilities
const base = '/api/v1';
const respondError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: 'Database error' });
};

// Health Check
app.get('/', (req, res) => res.json({ message: 'VH Health API is running.' }));
app.get(`${base}/health`, async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
});
app.get(`${base}/app-version`, (req, res) => res.json({ version: '1.0.0', updated_at: '2025-05-12' }));

// OTP Mock
app.post(`${base}/request-otp`, body('phoneNumber').isLength({ min: 10 }), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  res.json({ message: `Mock OTP 123456 sent to ${req.body.phoneNumber}` });
});
app.post(`${base}/verify-otp`, [body('phoneNumber').isLength({ min: 10 }), body('otp').isLength({ min: 6, max: 6 })], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  res.json(req.body.otp === '123456' ? { success: true, message: 'OTP verified' } : { success: false, message: 'Incorrect OTP' });
});

// Users
app.post(`${base}/users`, async (req, res) => {
  const { phoneNumber, name, gender, address, email, birthday, anniversary, profilePicture } = req.body;
  if (!phoneNumber || !name || !gender) return res.status(400).json({ error: 'Required fields missing.' });
  try {
    const result = await pool.query(`
      INSERT INTO users (phone, name, gender, address, email, birthday, anniversary, profile_picture, registered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (phone) DO UPDATE SET
        name=EXCLUDED.name, gender=EXCLUDED.gender, address=EXCLUDED.address,
        email=EXCLUDED.email, birthday=EXCLUDED.birthday,
        anniversary=EXCLUDED.anniversary, profile_picture=EXCLUDED.profile_picture
      RETURNING *`, [phoneNumber, name, gender, address, email, birthday, anniversary, profilePicture]);
    res.json({ message: 'User saved', user: result.rows[0] });
  } catch (err) { respondError(res, err); }
});
app.get(`${base}/users/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone=$1', [req.params.phone]);
    res.json(result.rows.length ? { exists: true, user: result.rows[0] } : { exists: false });
  } catch (err) { respondError(res, err); }
});
app.put(`${base}/users/:phone`, async (req, res) => {
  const { name, gender, address, email, birthday, anniversary, profilePicture } = req.body;
  try {
    const result = await pool.query(`
      UPDATE users SET name=$1, gender=$2, address=$3, email=$4, birthday=$5, anniversary=$6, profile_picture=$7
      WHERE phone=$8 RETURNING *`, [name, gender, address, email, birthday, anniversary, profilePicture, req.params.phone]);
    res.json(result.rows.length ? { message: 'Updated', user: result.rows[0] } : { error: 'Not found' });
  } catch (err) { respondError(res, err); }
});
app.get(`${base}/users`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users');
    res.json(result.rows);
  } catch (err) { respondError(res, err); }
});

// Appointments with Filter
app.post(`${base}/appointments`, async (req, res) => {
  const { phone, doctor_name, date, time } = req.body;
  if (!phone || !doctor_name || !date || !time) return res.status(400).json({ error: 'All fields required' });
  try {
    const result = await pool.query('INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1,$2,$3,$4) RETURNING *', [phone, doctor_name, date, time]);
    res.json({ message: 'Appointment booked', appointment: result.rows[0] });
  } catch (err) { respondError(res, err); }
});
app.get(`${base}/appointments/:phone`, async (req, res) => {
  try {
    const { phone } = req.params;
    const { filter } = req.query;
    const result = await pool.query('SELECT * FROM appointments WHERE phone=$1', [phone]);
    let appointments = result.rows;
    if (filter === 'upcoming') appointments = appointments.filter(a => new Date(a.date) >= new Date());
    if (filter === 'past') appointments = appointments.filter(a => new Date(a.date) < new Date());
    res.json(appointments);
  } catch (err) { respondError(res, err); }
});

// Health Records with Type Filter
app.post(`${base}/health-records`, async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) return res.status(400).json({ error: 'All fields required' });
  try {
    const result = await pool.query('INSERT INTO health_records (phone, file_name, file_type) VALUES ($1,$2,$3) RETURNING *', [phone, file_name, file_type]);
    res.json({ message: 'Health record added', record: result.rows[0] });
  } catch (err) { respondError(res, err); }
});
app.get(`${base}/health-records/:phone`, async (req, res) => {
  try {
    const { phone } = req.params;
    const { type } = req.query;
    const result = await pool.query('SELECT * FROM health_records WHERE phone=$1', [phone]);
    let records = result.rows;
    if (type) records = records.filter(r => r.file_type.toLowerCase() === type.toLowerCase());
    res.json(records);
  } catch (err) { respondError(res, err); }
});

// Investigations
app.post(`${base}/investigations`, async (req, res) => {
  const { phone, test_name } = req.body;
  if (!phone || !test_name) return res.status(400).json({ error: 'Missing test/phone' });
  try {
    const result = await pool.query('INSERT INTO investigations (phone, test_name) VALUES ($1,$2) RETURNING *', [phone, test_name]);
    res.json({ message: 'Investigation requested', investigation: result.rows[0] });
  } catch (err) { respondError(res, err); }
});
app.get(`${base}/investigations/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investigations WHERE phone=$1', [req.params.phone]);
    res.json(result.rows);
  } catch (err) { respondError(res, err); }
});

// Pharmacy Orders
app.post(`${base}/pharmacy-orders`, async (req, res) => {
  const { phone, order_note } = req.body;
  if (!phone || !order_note) return res.status(400).json({ error: 'Missing fields' });
  try {
    const result = await pool.query('INSERT INTO pharmacy_orders (phone, order_note) VALUES ($1,$2) RETURNING *', [phone, order_note]);
    res.json({ message: 'Order placed', order: result.rows[0] });
  } catch (err) { respondError(res, err); }
});
app.get(`${base}/pharmacy-orders/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pharmacy_orders WHERE phone=$1', [req.params.phone]);
    res.json(result.rows);
  } catch (err) { respondError(res, err); }
});

// Feedback
app.post(`${base}/feedback`, async (req, res) => {
  const { phoneNumber, rating, comment } = req.body;
  if (!phoneNumber || !rating) return res.status(400).json({ error: 'Required: phoneNumber & rating' });
  res.json({ success: true, message: 'Feedback received' });
});

// Doctor Profile
app.get(`${base}/doctors/:doctorId`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM doctors WHERE id=$1', [req.params.doctorId]);
    res.json(result.rows.length ? result.rows[0] : { error: 'Doctor not found' });
  } catch (err) { respondError(res, err); }
});

// Department Details
app.get(`${base}/departments/:departmentId`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments WHERE id=$1', [req.params.departmentId]);
    res.json(result.rows.length ? result.rows[0] : { error: 'Department not found' });
  } catch (err) { respondError(res, err); }
});

// Fallback Error Handler
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
