import assert from 'node:assert/strict';
import test from 'node:test';

function installWindow() {
  globalThis.window = {
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { pathname: '/', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
  };
  globalThis.document = { title: '', getElementById() { return null; }, addEventListener() {} };
}

function studentState(section) {
  return {
    user: { role: 'student', displayName: 'Jamie', permissions: {} },
    section: section || '',
    view: section || '',
    studentFocus: '',
    actingAs: '',
  };
}

test('students get Document, Journey, and Supervisor, and Journey is the default', async () => {
  installWindow();
  const router = await import('./router.js');
  const user = studentState().user;
  assert.deepEqual(router.sectionTabs(user, '').map((tab) => tab[1]), ['Document', 'Journey', 'Supervisor']);
  const home = studentState();
  router.applyRoute(router.matchPath('/'), home);
  assert.equal(home.section, 'journey');
  assert.equal(router.pathFromState(home), '/journey');
});

test('document, journey, and supervisor keep their own slugs, including old aliases', async () => {
  installWindow();
  const router = await import('./router.js');
  const cases = [
    ['/document', 'document', '/document'],
    ['/doc', 'document', '/document'],
    ['/my-ee', 'document', '/document'],
    ['/journey', 'journey', '/journey'],
    ['/supervisor', 'supervisor', '/supervisor'],
    ['/help', 'supervisor', '/supervisor'],
  ];
  cases.forEach((row) => {
    const appState = studentState();
    router.applyRoute(router.matchPath(row[0]), appState);
    assert.equal(appState.section, row[1], row[0]);
    assert.equal(router.pathFromState(appState), row[2], row[0]);
  });
});

test('a student /resources opens Journey focused on research support', async () => {
  installWindow();
  const router = await import('./router.js');
  const appState = studentState();
  router.applyRoute(router.matchPath('/resources'), appState);
  assert.equal(appState.section, 'journey');
  assert.equal(appState.studentFocus, 'research');
  assert.equal(router.pathFromState(appState), '/resources');
  router.applyRoute(router.matchPath('/journey'), appState);
  assert.equal(appState.studentFocus, '');
  assert.equal(router.pathFromState(appState), '/journey');
});

test('staff keep Resources and do not see the student views in the tab bar', async () => {
  installWindow();
  const router = await import('./router.js');
  const staff = { role: 'staff', permissions: { isSupervisor: true, canAdmin: false } };
  const tabs = router.sectionTabs(staff, 'supervisor').map((tab) => tab[0]);
  assert.equal(tabs.includes('resources'), true);
  assert.equal(tabs.includes('document'), false);
  const appState = { user: staff, actingAs: 'supervisor', section: '', view: '', studentFocus: 'research' };
  router.applyRoute(router.matchPath('/resources'), appState);
  assert.equal(appState.section, 'resources');
  assert.equal(router.pathFromState(appState), '/resources');
});
