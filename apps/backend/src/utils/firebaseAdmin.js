// src/utils/firebaseAdmin.js
import admin from 'firebase-admin';
import logger from '../logging/logger.js';

let firebaseAdmin;

try {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const hasCertCredentials = !!(projectId && clientEmail && privateKey);
  const useApplicationDefault =
    process.env.FIREBASE_USE_APPLICATION_DEFAULT === 'true' ||
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!admin.apps.length) {
    if (hasCertCredentials) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
      logger.info('Firebase Admin initialized from environment credentials');
    } else if (projectId && useApplicationDefault) {
      admin.initializeApp({
        projectId,
        credential: admin.credential.applicationDefault()
      });
      logger.info('Firebase Admin initialized from application default credentials');
    } else {
      throw new Error('Missing Firebase Admin credentials');
    }
  }

  firebaseAdmin = admin;
} catch (error) {
  logger.warn('⚠️ Firebase Admin not initialized:', error.message);

  // Failing stub keeps imports stable without pretending Firebase worked.
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
