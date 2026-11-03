import assert from 'node:assert/strict';
import test from 'node:test';
import { DOC_COMMENT_STALE_MS } from './docCommentsPure';
import { SWEEP_CRON, SWEEP_TIME_ZONE } from './schedules';

const DAY_MS = 24 * 60 * 60 * 1000;

test('scheduled sweeps are fixed at 04:00 Asia/Hong_Kong and the comment window outlasts one day', () => {
  assert.equal(SWEEP_CRON, '0 4 * * *');
  assert.equal(SWEEP_TIME_ZONE, 'Asia/Hong_Kong');
  assert.equal(DOC_COMMENT_STALE_MS > DAY_MS, true);
  assert.equal(DOC_COMMENT_STALE_MS, 25 * 60 * 60 * 1000);
});
