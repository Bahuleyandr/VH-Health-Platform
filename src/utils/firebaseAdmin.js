// src/utils/firebaseAdmin.js

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const serviceAccountPath = path.resolve('firebase-service-account.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error(
    '❌ firebase-service-account.json not found. Please generate it from Firebase Console.'
  );
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

export default admin;
