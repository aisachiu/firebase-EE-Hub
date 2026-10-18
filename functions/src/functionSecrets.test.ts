import assert from 'node:assert/strict';
import test from 'node:test';
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN } from './googleAuth';

const SECRET_NAMES = [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN];

test('eeHub and notificationSweep mount the three OAuth secrets', async () => {
  process.env.GCLOUD_PROJECT ||= 'demo-ee-hub';
  process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: 'demo-ee-hub' });
  const { eeHub, notificationSweep } = await import('./index');
  const functions = [eeHub, notificationSweep];
  assert.equal(functions.length, 2);
  functions.forEach((cloudFunction) => {
    const endpoint = (cloudFunction as { __endpoint?: { secretEnvironmentVariables?: Array<{ key?: string }> } }).__endpoint;
    const keys = (endpoint?.secretEnvironmentVariables || []).map((item) => item.key);
    assert.deepEqual(keys, SECRET_NAMES);
  });
});
