// src/utils/firebaseAdmin.js
import admin from 'firebase-admin';
import logger from '../logging/logger.js';

let firebaseAdmin;

try {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase credentials in environment variables');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
    logger.info('✅ Firebase Admin initialized from .env');
  }

  firebaseAdmin = admin;
} catch (error) {
  logger.warn('⚠️ Firebase Admin not initialized:', error.message);

  // Provide mock fallback to avoid breaking imports
  firebaseAdmin = {
    auth: () => ({
      verifyIdToken: () => Promise.reject(new Error('Firebase not configured')),
      createUser: () => Promise.reject(new Error('Firebase not configured'))
    }),
    messaging: () => ({
      send: () => Promise.reject(new Error('Firebase not configured'))
    })
  };
}

export default firebaseAdmin;
