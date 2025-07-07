import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

// This is the new, correct configuration from your Firebase project.
const firebaseConfig = {
  apiKey: "AIzaSyD66kpN2hC6cbIXguLxhY5slhBX2TuSVCQ",
  authDomain: "vhhealth.firebaseapp.com",
  projectId: "vhhealth",
  storageBucket: "vhhealth.firebasestorage.app",
  messagingSenderId: "155620159512",
  appId: "1:155620159512:web:ed8e4cc14d5e41549d136d"
};

// The rest of the file remains the same.
const app = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(app);

export async function firebaseLogin(email: string, password: string) {
  const userCred = await signInWithEmailAndPassword(firebaseAuth, email, password);
  return userCred.user;
}
