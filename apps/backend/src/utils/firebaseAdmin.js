// src/utils/firebaseAdmin.js
//
// firebase-admin 14 removed the legacy namespace API — the default export no
// longer carries `auth`, `messaging`, `credential` or `apps`. Everything below
// goes through the modular entry points instead. The exported facade keeps the
// `.auth()` / `.messaging()` shape its callers (and their test doubles) rely on.
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
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

  if (!getApps().length) {
    if (hasCertCredentials) {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
      logger.info('Firebase Admin initialized from environment credentials');
    } else if (projectId && useApplicationDefault) {
      initializeApp({
        projectId,
        credential: applicationDefault()
      });
      logger.info('Firebase Admin initialized from application default credentials');
    } else {
      throw new Error('Missing Firebase Admin credentials');
    }
  }

  // Resolved lazily, exactly as `admin.auth()` / `admin.messaging()` were —
  // both getters are memoised per app by the SDK.
  firebaseAdmin = {
    auth: () => getAuth(),
    messaging: () => getMessaging()
  };
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
