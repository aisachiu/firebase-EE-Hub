import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenancePageHtml } from '../maintenance.js';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  emptyServerSettings,
  maintenanceMessage,
  serverSettingsFromDoc,
} from './serverSettings.js';

test('server settings default to jobs on and maintenance off', () => {
  assert.equal(emptyServerSettings().loaded, false);
  assert.equal(emptyServerSettings().emailNotificationEnabled, true);
  assert.equal(emptyServerSettings().maintenanceMode, false);
  const fromEmpty = serverSettingsFromDoc(null);
  assert.equal(fromEmpty.loaded, true);
  assert.equal(fromEmpty.commentsSweepEnabled, true);
  assert.equal(fromEmpty.maintenanceMode, false);
  const saved = serverSettingsFromDoc({
    emailNotificationEnabled: false,
    commentsSweepEnabled: 'no',
    maintenanceMode: true,
    maintenanceNote: '  Back soon.  ',
    updatedAt: '2026-11-04T00:00:00.000Z',
  });
  assert.equal(saved.emailNotificationEnabled, false);
  assert.equal(saved.commentsSweepEnabled, false);
  assert.equal(saved.maintenanceMode, true);
  assert.equal(saved.maintenanceNote, 'Back soon.');
  assert.equal(maintenanceMessage(saved), 'Back soon.');
  assert.equal(maintenanceMessage({ maintenanceNote: '   ' }), DEFAULT_MAINTENANCE_MESSAGE);
});

test('the maintenance page shows the note, or a default, and escapes markup', () => {
  const custom = maintenancePageHtml({ maintenanceNote: '<b>Upgrading</b>' }, '<p><button type="button" id="maintenance-sign-out">Sign out</button></p>');
  assert.equal(custom.includes('<b>'), false);
  assert.equal(custom.includes('&lt;b&gt;Upgrading&lt;/b&gt;'), true);
  assert.equal(custom.includes("We'll be back soon"), true);
  assert.equal(custom.includes('id="maintenance-sign-out"'), true);
  const fallback = maintenancePageHtml({ maintenanceNote: '' }, '');
  assert.equal(fallback.includes(DEFAULT_MAINTENANCE_MESSAGE), true);
});
