import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCh-tCXGbS3oAHLlBlufQYeElZ2TGgfMlE",
  authDomain: "jk-pms.firebaseapp.com",
  projectId: "jk-pms",
  storageBucket: "jk-pms.firebasestorage.app",
  messagingSenderId: "402199134787",
  appId: "1:402199134787:web:b42d8954a1cd4bb33a8af6",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);
export const auth = getAuth(app);