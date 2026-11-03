import assert from 'node:assert/strict';
import test from 'node:test';
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN } from './googleAuth';
import { SWEEP_CRON, SWEEP_TIME_ZONE } from './schedules';

const SECRET_NAMES = [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REFRESH_TOKEN];

test('eeHub, notificationSweep, and docCommentSweep mount the three OAuth secrets', async () => {
  process.env.GCLOUD_PROJECT ||= 'demo-ee-hub';
  process.env.FIREBASE_CONFIG ||= JSON.stringify({ projectId: 'demo-ee-hub' });
  const { docCommentSweep, eeHub, notificationSweep } = await import('./index');
  const functions = [eeHub, notificationSweep, docCommentSweep];
  assert.equal(functions.length, 3);
  functions.forEach((cloudFunction) => {
    const endpoint = (cloudFunction as { __endpoint?: { secretEnvironmentVariables?: Array<{ key?: string }> } }).__endpoint;
    const keys = (endpoint?.secretEnvironmentVariables || []).map((item) => item.key);
    assert.deepEqual(keys, SECRET_NAMES);
  });
  [notificationSweep, docCommentSweep].forEach((cloudFunction) => {
    const trigger = (cloudFunction as { __endpoint?: { scheduleTrigger?: { schedule?: string; timeZone?: string } } }).__endpoint?.scheduleTrigger;
    assert.equal(trigger?.schedule, SWEEP_CRON);
    assert.equal(trigger?.timeZone, SWEEP_TIME_ZONE);
  });
});
