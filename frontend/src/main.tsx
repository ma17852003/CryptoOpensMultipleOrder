import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import './index.css'
import App from './App.tsx'

const firebaseConfig = {
  apiKey: "AIzaSyCmRndGpUr_maFt1u3eKVGM6kAibB_Mg8k",
  authDomain: "chrome-cipher-462503-f0.firebaseapp.com",
  projectId: "chrome-cipher-462503-f0",
  storageBucket: "chrome-cipher-462503-f0.firebasestorage.app",
  messagingSenderId: "489541975165",
  appId: "1:489541975165:web:354df07b2832af765bc514",
  measurementId: "G-G6M0WSZSJE"
};

const app = initializeApp(firebaseConfig);
if (typeof window !== "undefined") {
  getAnalytics(app);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
