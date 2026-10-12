import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { dispatch } from './dispatch';
import { verifiedGoogleEmail } from './identity';
import { App } from './session';
import { Store } from './store';
import { HubError, text } from './util';

initializeApp();
const store = new Store(getFirestore());

export const eeHub = onCall({ region: 'asia-east2', cors: true, invoker: 'public', timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  let email: string;
  try {
    email = verifiedGoogleEmail(request.auth);
  } catch (error) {
    const code = request.auth ? 'permission-denied' : 'unauthenticated';
    const message = error instanceof Error ? error.message : 'A verified Google account is required.';
    throw new HttpsError(code, message);
  }

  const method = text(request.data?.method);
  const args = Array.isArray(request.data?.args) ? request.data.args : [];
  const app: App = {
    store,
    email,
    timeZone: process.env.EE_TIMEZONE || 'Asia/Hong_Kong',
  };
  try {
    const result = await dispatch(app, method, args);
    return result === undefined ? null : result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The EE Hub could not complete that request.';
    const code = error instanceof HubError && message === 'Access denied.' ? 'permission-denied' : 'failed-precondition';
    console.error(method, message);
    throw new HttpsError(code, message);
  }
});
