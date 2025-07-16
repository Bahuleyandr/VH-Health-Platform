// generateAdminToken.js
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config({ path: '.env.local' }); // or adjust as needed

const payload = {
  uid: 'test-admin-uid',
  phone: '9876543210',
  role: 'ADMIN',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours
};

const secret = process.env.JWT_SECRET || 'myjwtsecret'; // fallback if not set

const token = jwt.sign(payload, secret, { algorithm: 'HS256' });

console.log('ADMIN JWT Token:\n');
console.log(token);
