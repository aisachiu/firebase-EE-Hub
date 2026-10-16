import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-ee-hub.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-ee-hub',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:0:web:demo',
};

const app = initializeApp(config);
const auth = getAuth(app);
const functions = getFunctions(app, 'asia-east2');
const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  window.eeSignInDemo = function(email) {
    const credential = GoogleAuthProvider.credential(JSON.stringify({
      sub: email,
      email: email,
      email_verified: true,
    }));
    return signInWithCredential(auth, credential);
  };
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

window.eeUseEmulators = useEmulators;

function googleDriveToken(scope) {
  const provider = new GoogleAuthProvider();
  provider.addScope(scope);
  const hint = window.eeUser && window.eeUser.email ? window.eeUser.email : '';
  const params = { prompt: 'consent', include_granted_scopes: 'true' };
  if (hint) params.login_hint = hint;
  provider.setCustomParameters(params);
  return signInWithPopup(auth, provider).then(function(result) {
    const credential = GoogleAuthProvider.credentialFromResult(result);
    return credential && credential.accessToken ? credential.accessToken : '';
  });
}

window.eeConnectDrive = function() {
  return googleDriveToken('https://www.googleapis.com/auth/drive');
};

window.eeConnectDriveRead = function() {
  return googleDriveToken('https://www.googleapis.com/auth/drive.readonly');
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
