const express = require('express');
const cors = require('cors');
require('./instrument');
require('dotenv').config();
require('./instrument'); // Already initializes Sentry globally
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const pool = require('./db');
const logger = require('./logger');
const { validatePhoneNumber, validateOTP } = require('./middleware/validators');
const { success, error } = require('./responseHelper');

require('./validateEnv');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
const helmet = require('helmet');
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
}));

app.use(express.json());
app.use(helmet());

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

// Health Check
app.get('/', (req, res) => res.json({ message: 'VH Health API is running.' }));
app.get(`${base}/health`, async (req, res) => {
  try {
    // Check Database
    await pool.query('SELECT 1');

    // Check Environment Variables
    const requiredEnv = ['API_KEY', 'DATABASE_URL', 'ALLOWED_ORIGINS'];
    const missingEnv = requiredEnv.filter(key => !process.env[key]);

    if (missingEnv.length > 0) {
      return res.status(500).json({
        status: 'error',
        message: `Missing environment variables: ${missingEnv.join(', ')}`
      });
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'connected',
        environment: 'all variables present'
      }
    });
  } catch (err) {
    logger.error(err.stack || err.toString());
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
});
app.get(`${base}/app-version`, (req, res) => res.json({ version: '1.0.0', updated_at: '2025-05-12' }));

// OTP Mock
app.post(`${base}/request-otp`, validatePhoneNumber, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  res.json({ message: `Mock OTP 123456 sent to ${req.body.phoneNumber}` });
});
app.post(`${base}/verify-otp`, [validatePhoneNumber, validateOTP], (req, res) => {
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
    success(res, result.rows[0], 'User saved');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.get(`${base}/users/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone=$1', [req.params.phone]);
    if (result.rows.length) {
  success(res, result.rows[0], 'User found');
} else {
  error(res, 'User not found', 404);
}
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.put(`${base}/users/:phone`, async (req, res) => {
  const { name, gender, address, email, birthday, anniversary, profilePicture } = req.body;
  try {
    const result = await pool.query(`
      UPDATE users SET name=$1, gender=$2, address=$3, email=$4, birthday=$5, anniversary=$6, profile_picture=$7
      WHERE phone=$8 RETURNING *`, [name, gender, address, email, birthday, anniversary, profilePicture, req.params.phone]);
    if (result.rows.length) {
  success(res, result.rows[0], 'User updated');
} else {
  error(res, 'User not found', 404);
}
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.get(`${base}/users`, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const query = req.query.query ? `%${req.query.query.toLowerCase()}%` : null;

    let result;

    if (query) {
      result = await pool.query(
        `SELECT * FROM users 
         WHERE LOWER(name) LIKE $1 OR phone LIKE $1 
         ORDER BY registered_at DESC 
         LIMIT $2 OFFSET $3`,
        [query, limit, offset]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM users ORDER BY registered_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
    }

    success(res, { page, limit, data: result.rows }, 'User list fetched');
  } catch (err) { 
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Appointments with Filter
app.post(`${base}/appointments`, async (req, res) => {
  const { phone, doctor_name, date, time } = req.body;
  if (!phone || !doctor_name || !date || !time) return res.status(400).json({ error: 'All fields required' });
  try {
    const result = await pool.query('INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1,$2,$3,$4) RETURNING *', [phone, doctor_name, date, time]);
    success(res, result.rows[0], 'Appointment booked');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.get(`${base}/appointments/:phone`, async (req, res) => {
  try {
    const { phone } = req.params;
    const { filter, doctor_name, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let queryText = 'SELECT * FROM appointments WHERE phone = $1';
    const queryParams = [phone];

    if (doctor_name) {
      queryText += ' AND LOWER(doctor_name) LIKE $2';
      queryParams.push(`%${doctor_name.toLowerCase()}%`);
    }

    queryText += ' ORDER BY date DESC LIMIT $3 OFFSET $4';
    queryParams.push(limit, offset);

    const result = await pool.query(queryText, queryParams);

    let appointments = result.rows;
    if (filter === 'upcoming') appointments = appointments.filter(a => new Date(a.date) >= new Date());
    if (filter === 'past') appointments = appointments.filter(a => new Date(a.date) < new Date());

    success(res, { page: parseInt(page), limit: parseInt(limit), data: appointments }, 'Appointments fetched');
  } catch (err) { 
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Health Records with Type Filter
app.post(`${base}/health-records`, async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) return res.status(400).json({ error: 'All fields required' });
  try {
    const result = await pool.query('INSERT INTO health_records (phone, file_name, file_type) VALUES ($1,$2,$3) RETURNING *', [phone, file_name, file_type]);
    success(res, result.rows[0], 'Health record added');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.get(`${base}/health-records/:phone`, async (req, res) => {
  try {
    const { phone } = req.params;
    const { type } = req.query;
    const result = await pool.query('SELECT * FROM health_records WHERE phone=$1', [phone]);
    let records = result.rows;
    if (type) records = records.filter(r => r.file_type.toLowerCase() === type.toLowerCase());
    success(res, records, 'Health records fetched');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});

// Investigations
app.post(`${base}/investigations`, async (req, res) => {
  const { phone, test_name } = req.body;
  if (!phone || !test_name) return res.status(400).json({ error: 'Missing test/phone' });
  try {
    const result = await pool.query('INSERT INTO investigations (phone, test_name) VALUES ($1,$2) RETURNING *', [phone, test_name]);
    success(res, result.rows[0], 'Investigation requested');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.get(`${base}/investigations/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investigations WHERE phone=$1', [req.params.phone]);
    success(res, result.rows, 'Investigations fetched');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});

// Pharmacy Orders
app.post(`${base}/pharmacy-orders`, async (req, res) => {
  const { phone, order_note } = req.body;
  if (!phone || !order_note) return res.status(400).json({ error: 'Missing fields' });
  try {
    const result = await pool.query('INSERT INTO pharmacy_orders (phone, order_note) VALUES ($1,$2) RETURNING *', [phone, order_note]);
    success(res, result.rows[0], 'Order placed');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});
app.get(`${base}/pharmacy-orders/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pharmacy_orders WHERE phone=$1', [req.params.phone]);
    success(res, result.rows, 'Pharmacy orders fetched');
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});

// Feedback
app.post(`${base}/feedback`, async (req, res) => {
  const { phoneNumber, rating, comment } = req.body;
  if (!phoneNumber || !rating) return res.status(400).json({ error: 'Required: phoneNumber & rating' });
  res.json({ success: true, message: 'Feedback received' });
});

// Doctor Profile
app.get(`${base}/doctors`, async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      const result = await pool.query('SELECT * FROM doctors ORDER BY name ASC');
      return success(res, result.rows, 'Doctors fetched');
    }

    const search = `%${query.toLowerCase()}%`;
    const result = await pool.query(
      `SELECT * FROM doctors 
       WHERE LOWER(name) LIKE $1 OR LOWER(specialty) LIKE $1 
       ORDER BY name ASC`,
      [search]
    );

    success(res, result.rows, 'Doctors search results');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});
app.get(`${base}/doctors/:doctorId`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM doctors WHERE id=$1', [req.params.doctorId]);
    if (result.rows.length) {
  success(res, result.rows[0], 'Doctor profile found');
} else {
  error(res, 'Doctor not found', 404);
}
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});

// Department Details
app.get(`${base}/departments`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
    success(res, result.rows, 'Departments fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});
app.get(`${base}/departments/:departmentId`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments WHERE id=$1', [req.params.departmentId]);
    if (result.rows.length) {
  success(res, result.rows[0], 'Department details found');
} else {
  error(res, 'Department not found', 404);
}
  } catch (err) { 
  logger.error(err.stack || err.toString());
  error(res, 'Database error');
}
});

app.get('/debug-sentry', (req, res) => {
  throw new Error("My first Sentry error!");
});

// Fallback Error Handler
app.use((err, req, res, next) => {
  logger.error(`Unexpected error: ${err.stack}`);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
