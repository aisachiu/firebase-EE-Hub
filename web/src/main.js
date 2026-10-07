import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-ee-hub.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-ee-hub',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:0:web:demo',
};

const app = initializeApp(config);
const auth = getAuth(app);
const functions = getFunctions(app);
const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

const eeHub = httpsCallable(functions, 'eeHub');

window.eeCall = function(method, args) {
  return eeHub({ method: method, args: args || [] }).then(function(result) {
    return result.data;
  });
};

window.eeSignIn = function() {
  return signInWithPopup(auth, new GoogleAuthProvider());
};

window.eeSignInDemo = function(email) {
  return signInWithEmailAndPassword(auth, email, 'ee-hub-demo');
};

window.eeSignOut = function() {
  return signOut(auth);
};

window.eeDemoAccounts = useEmulators ? [
  { email: 'student@vsa.example.edu', label: 'Student demo' },
  { email: 'supervisor@vsa.example.edu', label: 'Supervisor demo' },
  { email: 'coordinator@vsa.example.edu', label: 'Coordinator demo' },
] : [];

window.eeAuthReady = new Promise(function(resolve) {
  const stop = onAuthStateChanged(auth, function(user) {
    window.eeUser = user;
    stop();
    resolve(user);
  });
});

onAuthStateChanged(auth, function(user) {
  window.eeUser = user;
  if (typeof window.eeOnAuth === 'function') window.eeOnAuth(user);
});
