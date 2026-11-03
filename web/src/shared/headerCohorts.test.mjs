import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.window = globalThis;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const cohorts = await import('./headerCohorts.js');
const navigation = await import('../navigation.js');
const { state } = await import('./state.js');

function settle() {
  return new Promise(function(resolve) { setImmediate(resolve); });
}

function installDocument(select, app) {
  globalThis.document = {
    getElementById(id) {
      if (id === 'header-cohort') return select;
      if (id === 'app') return app || null;
      return null;
    },
  };
}

function fakeSelect() {
  const select = {
    disabled: false,
    dataset: {},
    value: '',
    options: [],
    _html: '',
  };
  Object.defineProperty(select, 'innerHTML', {
    get() { return select._html; },
    set(html) {
      select._html = html;
      const found = [];
      const pattern = /<option value="([^"]*)"/g;
      let match;
      while ((match = pattern.exec(html))) found.push({ value: match[1] });
      select.options = found;
    },
  });
  return select;
}

function reset() {
  cohorts.releaseHeaderCohortsWatch();
  state.user = null;
  state.cohortId = '';
  state.headerCohorts = null;
  state.isProvisioning = false;
  state.staffHome = { students: 1 };
  state.requests = { active: 0, reads: 0, writes: 0, nextId: 0 };
  state.mutationQueues = {};
  delete window.eeWatchCohorts;
  delete window.eeCall;
  navigation.setShellRenderer(function() {});
}

test('active header cohorts keep the server shape and drop archived cohorts', function() {
  assert.deepEqual(cohorts.activeHeaderCohorts([
    { id: '2028', Cohort: '2028', Status: 'Inactive' },
    { id: '2026', name: '2026', sheetName: 'COHORT_2026' },
    { Cohort: '2027', Status: 'Active', SheetName: 'COHORT_2027' },
    { Cohort: '', Status: 'Active' },
  ]), [
    { id: '2026', name: '2026' },
    { id: '2027', name: '2027' },
  ]);
});

test('the header cohort list follows the cohorts collection', async function() {
  reset();
  const select = fakeSelect();
  const app = {};
  installDocument(select, app);
  let followed = 0;
  navigation.setShellRenderer(function() { followed += 1; });
  let watchers = 0;
  let stopped = 0;
  let handlers = null;
  window.eeWatchCohorts = function(next) {
    watchers += 1;
    handlers = next;
    return function() { stopped += 1; };
  };
  window.eeCall = function() { throw new Error('getCohorts should not run while the listener is live'); };
  state.user = { role: 'staff', permissions: { canAdmin: true } };
  state.cohortId = '2026';
  cohorts.ensureHeaderCohorts();
  cohorts.ensureHeaderCohorts();
  assert.equal(watchers, 1);
  handlers.onData([
    { id: '2026', Cohort: '2026', Status: 'Active' },
    { id: '2027', Cohort: '2027', Status: 'Active' },
  ]);
  assert.deepEqual(state.headerCohorts, [
    { id: '2026', name: '2026' },
    { id: '2027', name: '2027' },
  ]);
  assert.match(select.innerHTML, /value="2027"/);
  assert.equal(select.value, '2026');
  assert.equal(followed, 0);

  handlers.onData([
    { id: '2026', Cohort: '2026', name: 'Class of 2026', Status: 'Active' },
    { id: '2027', Cohort: '2027', Status: 'Active' },
    { id: '2028', Cohort: '2028', Status: 'Active' },
  ]);
  assert.match(select.innerHTML, /Class of 2026/);
  assert.match(select.innerHTML, /value="2028"/);
  assert.equal(state.cohortId, '2026');
  assert.equal(followed, 0);

  cohorts.rememberHeaderCohorts([{ id: '1999', name: '1999' }]);
  assert.equal(state.headerCohorts.some(function(cohort) { return cohort.id === '2028'; }), true);
  assert.equal(state.headerCohorts.some(function(cohort) { return cohort.id === '1999'; }), false);

  handlers.onData([
    { id: '2026', Cohort: '2026', Status: 'Inactive' },
    { id: '2027', Cohort: '2027', Status: 'Active' },
  ]);
  assert.deepEqual(state.headerCohorts, [{ id: '2027', name: '2027' }]);
  assert.equal(state.cohortId, '2027');
  assert.doesNotMatch(select.innerHTML, /value="2026"/);
  await settle();
  assert.equal(followed, 1);
  assert.equal(state.staffHome, null);

  let refreshed = 0;
  window.eeCall = function(method) {
    refreshed += 1;
    assert.equal(method, 'getCohorts');
    return Promise.resolve([{ id: '2027', name: '2027' }, { id: '2030', name: '2030' }]);
  };
  cohorts.refreshHeaderCohorts();
  await settle();
  assert.equal(refreshed, 1);
  assert.deepEqual(state.headerCohorts, [
    { id: '2027', name: '2027' },
    { id: '2030', name: '2030' },
  ]);
  assert.match(select.innerHTML, /value="2030"/);
  assert.equal(followed, 1);

  let releaseFetch;
  window.eeCall = function() {
    return new Promise(function(resolve) { releaseFetch = resolve; });
  };
  cohorts.refreshHeaderCohorts();
  handlers.onData([
    { id: '2027', Cohort: '2027', Status: 'Active' },
    { id: '2031', Cohort: '2031', Status: 'Active' },
  ]);
  releaseFetch([{ id: '1990', name: '1990' }]);
  await settle();
  assert.deepEqual(state.headerCohorts.map(function(cohort) { return cohort.id; }), ['2027', '2031']);
  cohorts.releaseHeaderCohortsWatch();
  assert.equal(stopped, 1);
});

test('staff without coordinator access still load cohorts once', async function() {
  reset();
  const select = fakeSelect();
  installDocument(select, null);
  let watched = 0;
  window.eeWatchCohorts = function() { watched += 1; return function() {}; };
  let calls = 0;
  window.eeCall = function(method) {
    calls += 1;
    assert.equal(method, 'getCohorts');
    return Promise.resolve([{ id: '2026', name: '2026' }, { id: '2025', name: '2025', status: 'Inactive' }]);
  };
  state.user = { role: 'staff', permissions: { canAdmin: false } };
  cohorts.ensureHeaderCohorts();
  cohorts.ensureHeaderCohorts();
  await settle();
  assert.equal(watched, 0);
  assert.equal(calls, 1);
  assert.deepEqual(state.headerCohorts, [{ id: '2026', name: '2026' }]);
  assert.match(select.innerHTML, /value="2026"/);
  assert.doesNotMatch(select.innerHTML, /2025/);
});

test('a failed listener falls back to a refresh after the admin save', async function() {
  reset();
  const select = fakeSelect();
  installDocument(select, {});
  let handlers = null;
  window.eeWatchCohorts = function(next) {
    handlers = next;
    return function() {};
  };
  const payloads = [];
  window.eeCall = function() {
    return Promise.resolve(payloads.shift() || []);
  };
  state.user = { role: 'staff', permissions: { canAdmin: true } };
  state.cohortId = '2026';
  cohorts.ensureHeaderCohorts();
  payloads.push([{ id: '2026', name: '2026' }]);
  handlers.onError(new Error('Missing or insufficient permissions.'));
  await settle();
  assert.deepEqual(state.headerCohorts, [{ id: '2026', name: '2026' }]);

  payloads.push([
    { id: '2026', name: '2026' },
    { id: '2029', name: '2029' },
  ]);
  cohorts.refreshHeaderCohorts();
  await settle();
  assert.deepEqual(state.headerCohorts, [
    { id: '2026', name: '2026' },
    { id: '2029', name: '2029' },
  ]);
  assert.match(select.innerHTML, /value="2029"/);
  assert.equal(state.cohortId, '2026');
});

test('admin cohort save and archive refresh the header list', function() {
  const records = fs.readFileSync(new URL('../admin/records.js', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(records, /refreshHeaderCohorts\(\)/);
  assert.match(records, /if \(entity === 'cohorts'\) refreshHeaderCohorts\(\)/);
  assert.match(main, /window\.eeWatchCohorts/);
  assert.match(main, /onSnapshot\(collection\(db, 'cohorts'\)/);
});
