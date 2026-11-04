import assert from 'node:assert/strict';
import test from 'node:test';

function element() {
  return {
    innerHTML: '',
    hidden: false,
    textContent: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function installDom(pathname) {
  const nodes = {};
  function node(id) {
    if (!nodes[id]) nodes[id] = element();
    return nodes[id];
  }
  globalThis.window = {
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { pathname: pathname, search: '', hash: '' },
    history: {
      pushState(data, title, path) { window.location.pathname = String(path).split('?')[0]; },
      replaceState(data, title, path) { window.location.pathname = String(path).split('?')[0]; },
    },
    addEventListener() {},
    setTimeout: globalThis.setTimeout,
    eeUser: null,
    eeAuthReady: Promise.resolve(null),
    eeServerSettingsStatus: 'idle',
    eeServerSettingsData: null,
    eeDemoAccounts: [],
    eeCall(method) {
      assert.equal(method, 'getAppBootstrap');
      return Promise.resolve({
        user: { role: 'student', displayName: 'Jamie', permissions: {} },
        messages: {},
      });
    },
  };
  globalThis.document = {
    title: '',
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    documentElement: { style: { setProperty() {} } },
    getElementById: node,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return node('app');
}

test('a signed-in student is kept on the maintenance page until the mode is off', async () => {
  const app = installDom('/my-ee');
  const shell = await import('./shell.js');
  window.eeUser = { email: 'student@vsa.example.edu' };
  window.eeAuthReady = Promise.resolve(window.eeUser);
  shell.start();
  await new Promise((resolve) => setImmediate(resolve));
  window.eeOnServerSettings({ maintenanceMode: true, maintenanceNote: 'Back in one hour.' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.location.pathname, '/maintenance');
  assert.match(app.innerHTML, /Back in one hour/);
  assert.match(app.innerHTML, /We'll be back soon/);
  assert.equal(document.title, 'Maintenance · EE Hub');

  window.eeOnServerSettings({ maintenanceMode: true, maintenanceNote: 'Back in one hour.' });
  assert.match(app.innerHTML, /Back in one hour/);
  assert.equal(window.location.pathname, '/maintenance');

  window.eeOnServerSettings({ maintenanceMode: true, maintenanceNote: '' });
  assert.match(app.innerHTML, /temporarily unavailable/);
  assert.equal(window.location.pathname, '/maintenance');
});
