import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the Server admin section is registered beside the scheduled jobs it controls', () => {
  const sections = fs.readFileSync(new URL('./sections.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(sections, /\['serverSettings', 'Server'\]/);
  assert.match(sections, /renderServerSettings\(target\)/);
  assert.match(server, /getServerSettings/);
  assert.match(server, /saveServerSettings/);
  assert.match(server, /notificationSweep/);
  assert.match(server, /docCommentSweep/);
  assert.match(server, /id="server-maintenance-note"/);
  assert.match(server, /id="save-server-settings"/);
});
