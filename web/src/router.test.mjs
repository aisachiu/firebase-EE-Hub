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

test('students get My EE, Resources, and Help, and My EE is the default', async () => {
  installWindow();
  const router = await import('./router.js');
  const user = studentState().user;
  assert.deepEqual(router.sectionTabs(user, '').map((tab) => tab[1]), ['My EE', 'Resources', 'Help']);
  const home = studentState();
  router.applyRoute(router.matchPath('/'), home);
  assert.equal(home.section, 'my-ee');
  assert.equal(router.pathFromState(home), '/my-ee');
  assert.equal(router.searchForState(home), '');
});

test('old document, journey, and supervisor links open My EE on the matching page', async () => {
  installWindow();
  const router = await import('./router.js');
  const cases = [
    ['/document', 0, ''],
    ['/doc', 0, ''],
    ['/my-ee', 0, ''],
    ['/journey', 1, '?page=1'],
    ['/supervisor', 3, '?page=3'],
    ['/help', 'help', ''],
  ];
  cases.forEach((row) => {
    const appState = studentState();
    router.applyRoute(router.matchPath(row[0]), appState);
    if (row[1] === 'help') {
      assert.equal(appState.section, 'help', row[0]);
      assert.equal(router.pathFromState(appState), '/help', row[0]);
      return;
    }
    assert.equal(appState.section, 'my-ee', row[0]);
    if (row[0] !== '/my-ee') assert.equal(appState.eePage, row[1], row[0]);
    assert.equal(router.pathFromState(appState), '/my-ee', row[0]);
    appState.eePage = row[1];
    assert.equal(router.searchForState(appState), row[2], row[0]);
  });
});

test('a student /resources stays on Resources', async () => {
  installWindow();
  const router = await import('./router.js');
  const appState = studentState();
  router.applyRoute(router.matchPath('/resources'), appState);
  assert.equal(appState.section, 'resources');
  assert.equal(appState.studentFocus, '');
  assert.equal(router.pathFromState(appState), '/resources');
  assert.equal(router.searchForState(appState), '');
  appState.section = 'my-ee';
  appState.eePage = 4;
  assert.equal(router.searchForState(appState), '?page=4');
  assert.equal(router.titleForState(appState), 'My EE · EE Hub');
});

test('student tasks replace the assignments admin path', async () => {
  installWindow();
  const router = await import('./router.js');
  const user = { role: 'staff', permissions: { canAdmin: true, isSupervisor: false } };
  const appState = { user: user, actingAs: 'coordinator', section: '', view: '', studentFocus: '', adminEntity: '', staffPane: '' };
  router.applyRoute(router.matchPath('/admin/student-tasks'), appState);
  assert.equal(appState.section, 'admin');
  assert.equal(appState.adminEntity, 'studentTasks');
  assert.equal(router.pathFromState(appState), '/admin/student-tasks');
  assert.equal(router.titleForState(appState), 'Student Tasks · EE Hub');
  const legacy = { user: user, actingAs: 'coordinator', section: '', view: '', studentFocus: '', adminEntity: '', staffPane: '' };
  router.applyRoute(router.matchPath('/admin/assignments'), legacy);
  assert.equal(legacy.adminEntity, 'studentTasks');
  assert.equal(router.pathFromState(legacy), '/admin/student-tasks');
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
