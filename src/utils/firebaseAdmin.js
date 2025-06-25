// src/utils/firebaseAdmin.js

import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const serviceAccountPath = path.resolve('firebase-service-account.json');

// Create a default admin object to export
let firebaseAdmin;

// ✅ Make Firebase optional - don't crash if missing
if (!fs.existsSync(serviceAccountPath)) {
  console.log('⚠️ Firebase service account not found - Firebase features disabled');
  console.log('💡 To enable Firebase: Add firebase-service-account.json to project root');
  
  // Create a mock admin object to prevent import errors
  firebaseAdmin = {
    auth: () => ({
      verifyIdToken: () => Promise.reject(new Error('Firebase not configured')),
      createUser: () => Promise.reject(new Error('Firebase not configured'))
    }),
    messaging: () => ({
      send: () => Promise.reject(new Error('Firebase not configured'))
    })
  };
} else {
  // ✅ Firebase is available - configure normally
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('✅ Firebase Admin initialized successfully');
    }

    firebaseAdmin = admin;
  } catch (error) {
    console.error('❌ Firebase initialization failed:', error.message);
    
    // Create mock admin on error
    firebaseAdmin = {
      auth: () => ({
        verifyIdToken: () => Promise.reject(new Error('Firebase initialization failed')),
        createUser: () => Promise.reject(new Error('Firebase initialization failed'))
      }),
      messaging: () => ({
        send: () => Promise.reject(new Error('Firebase initialization failed'))
      })
    };
  }
}

// ✅ Single export statement at the end
export default firebaseAdmin;