import './styles/app.css';
import { start } from './shell.js';

import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut } from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getFirestore, onSnapshot } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-ee-hub.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-ee-hub',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:0:web:demo',
};

const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'asia-east2');
const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
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

function allocationDocs(snap) {
  return snap.docs.map(function(item) {
    return Object.assign({ id: item.id }, item.data());
  });
}

window.eeWatchAllocation = function(cohortId, handlers) {
  let stopped = false;
  const unsubs = [];
  const bucket = {
    members: null,
    workspace: null,
    tokens: null,
    settings: null,
    staff: null,
    subjects: null,
  };
  const seen = {};
  function emit(key, value) {
    if (stopped) return;
    bucket[key] = value;
    seen[key] = true;
    const ready = Object.keys(bucket).every(function(name) { return seen[name]; });
    if (!ready || typeof handlers.onData !== 'function') return;
    handlers.onData({
      members: bucket.members,
      workspace: bucket.workspace,
      tokens: bucket.tokens,
      settings: bucket.settings,
      staff: bucket.staff,
      subjects: bucket.subjects,
    });
  }
  function fail(error) {
    if (stopped) return;
    stopped = true;
    unsubs.forEach(function(stop) { stop(); });
    if (typeof handlers.onError === 'function') handlers.onError(error);
  }
  unsubs.push(onSnapshot(collection(db, 'cohorts', cohortId, 'members'), function(snap) { emit('members', allocationDocs(snap)); }, fail));
  unsubs.push(onSnapshot(collection(db, 'cohorts', cohortId, 'allocationWorkspace'), function(snap) { emit('workspace', allocationDocs(snap)); }, fail));
  unsubs.push(onSnapshot(collection(db, 'cohorts', cohortId, 'supervisorTokens'), function(snap) { emit('tokens', allocationDocs(snap)); }, fail));
  unsubs.push(onSnapshot(doc(db, 'cohorts', cohortId, 'allocationConfig', 'settings'), function(snap) {
    emit('settings', snap.exists() ? snap.data() : null);
  }, fail));
  unsubs.push(onSnapshot(collection(db, 'staffUsers'), function(snap) { emit('staff', allocationDocs(snap)); }, fail));
  unsubs.push(onSnapshot(collection(db, 'subjects'), function(snap) { emit('subjects', allocationDocs(snap)); }, fail));
  return function() {
    stopped = true;
    unsubs.forEach(function(stop) { stop(); });
  };
};

window.eeSignIn = function() {
  return signInWithPopup(auth, new GoogleAuthProvider());
};

window.eeUseEmulators = useEmulators;

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

start();
