// src/utils/firebaseAdmin.js

import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccountPath = '/etc/secrets/firebase-service-account.json'; // ← this matches the Render secret path

if (!fs.existsSync(serviceAccountPath)) {
  console.error('❌ firebase-service-account.json not found at expected secret file path.');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

export default admin;
