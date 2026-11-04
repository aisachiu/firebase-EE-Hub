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

test('students get My EE and Resources, and My EE is the default', async () => {
  installWindow();
  const router = await import('./router.js');
  const user = studentState().user;
  assert.deepEqual(router.sectionTabs(user, '').map((tab) => tab[1]), ['My EE', 'Resources']);
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
  ];
  cases.forEach((row) => {
    const appState = studentState();
    router.applyRoute(router.matchPath(row[0]), appState);
    assert.equal(appState.section, 'my-ee', row[0]);
    if (row[0] !== '/my-ee') assert.equal(appState.eePage, row[1], row[0]);
    assert.equal(router.pathFromState(appState), '/my-ee', row[0]);
    appState.eePage = row[1];
    assert.equal(router.searchForState(appState), row[2], row[0]);
  });
  ['/help', '/messages', '/admin/categories'].forEach((path) => {
    const appState = studentState();
    router.applyRoute(router.matchPath(path), appState);
    assert.equal(appState.section, 'my-ee', path);
    assert.equal(router.pathFromState(appState), '/my-ee', path);
    assert.equal(router.searchForState(appState), '', path);
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
  const pages = { user: user, actingAs: 'coordinator', section: '', view: '', studentFocus: '', adminEntity: '', staffPane: '' };
  router.applyRoute(router.matchPath('/admin/student-pages'), pages);
  assert.equal(pages.section, 'admin');
  assert.equal(pages.adminEntity, 'studentPages');
  assert.equal(router.pathFromState(pages), '/admin/student-pages');
  assert.equal(router.titleForState(pages), 'Student Pages · EE Hub');
});

test('a staff student link keeps the student id and /my-ee stays a student route', async () => {
  installWindow();
  const router = await import('./router.js');
  const staff = { role: 'staff', permissions: { isSupervisor: true, canAdmin: false } };
  const appState = { user: staff, actingAs: 'supervisor', section: '', view: '', studentFocus: '', staffStudentId: '' };
  router.applyRoute(router.matchPath('/my-students/Student%40vsa.example.edu'), appState);
  assert.equal(appState.section, 'students');
  assert.equal(appState.staffStudentId, 'student@vsa.example.edu');
  assert.equal(router.pathFromState(appState), '/my-students/student%40vsa.example.edu');
  assert.equal(router.matchPath(router.pathFromState(appState)).studentId, 'student@vsa.example.edu');
  router.applyRoute(router.matchPath('/my-students/student@vsa.example.edu'), appState);
  assert.equal(appState.staffStudentId, 'student@vsa.example.edu');
  assert.equal(appState.staffStudentHome, null);
  router.applyRoute(router.matchPath('/my-students'), appState);
  assert.equal(appState.section, 'students');
  assert.equal(appState.staffStudentId, '');
  assert.equal(router.pathFromState(appState), '/my-students');
  const student = studentState();
  student.eePage = 1;
  assert.equal(router.matchPath('/my-ee/student@vsa.example.edu'), null);
  router.applyRoute(router.matchPath('/my-students/student@vsa.example.edu'), student);
  assert.equal(student.section, 'my-ee');
  assert.equal(student.eePage, 1);
  assert.equal(router.pathFromState(student), '/my-ee');
  assert.equal(router.searchForState(student), '?page=1');
  const journey = studentState();
  router.applyRoute(router.matchPath('/journey'), journey);
  assert.equal(journey.section, 'my-ee');
  assert.equal(journey.eePage, 1);
  assert.equal(router.pathFromState(journey), '/my-ee');
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

test('a head of department opens Allocation on the department view', async () => {
  installWindow();
  const router = await import('./router.js');
  const hod = { role: 'staff', email: 'hod@school.edu', permissions: { isHOD: true, canAdmin: false, isSupervisor: false } };
  assert.deepEqual(router.sectionTabs(hod, 'staff').map((tab) => tab[0]), ['students', 'resources', 'allocation']);
  const appState = { user: hod, actingAs: 'staff', section: '', view: '', studentFocus: '', allocationView: '' };
  router.applyRoute(router.matchPath('/allocation'), appState);
  assert.equal(appState.section, 'allocation');
  assert.equal(appState.allocationView, 'hod');
  assert.equal(router.pathFromState(appState), '/allocation/hod');
  assert.equal(router.titleForState(appState), 'Department · EE Hub');
  router.applyRoute(router.matchPath('/allocation/tokens'), appState);
  assert.equal(appState.allocationView, 'hod');
  const both = { role: 'staff', permissions: { isHOD: true, canAdmin: true } };
  assert.ok(router.sectionTabs(both, 'coordinator').map((tab) => tab[0]).includes('admin'));
  const coordinator = { user: both, actingAs: 'coordinator', section: '', view: '', studentFocus: '', allocationView: '' };
  router.applyRoute(router.matchPath('/allocation'), coordinator);
  assert.equal(coordinator.allocationView, 'dashboard');
  assert.equal(router.pathFromState(coordinator), '/allocation');
  router.applyRoute(router.matchPath('/allocation/hod'), coordinator);
  assert.equal(coordinator.allocationView, 'hod');
  assert.equal(router.pathFromState(coordinator), '/allocation/hod');
});
