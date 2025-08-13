import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

// This is the new, correct configuration from your Firebase project.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// The rest of the file remains the same.
const app = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(app);

export async function firebaseLogin(email: string, password: string) {
  const userCred = await signInWithEmailAndPassword(
    firebaseAuth,
    email,
    password,
  );
  return userCred.user;
}
