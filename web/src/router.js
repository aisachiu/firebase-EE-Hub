import { state } from './shared/state.js';

const SECTION_SLUGS = {
  document: 'document',
  journey: 'journey',
  supervisor: 'supervisor',
  doc: 'document',
  'my-ee': 'document',
  resources: 'resources',
  help: 'supervisor',
  'my-students': 'students',
  messages: 'tickets',
  notes: 'notes',
};

const SECTION_TITLES = {
  document: 'Document',
  journey: 'Journey',
  supervisor: 'Supervisor',
  resources: 'Resources',
  students: 'My Students',
  tickets: 'Messages',
  notes: 'Notes',
};

const ADMIN_PANELS = {
  cohorts: { adminEntity: 'cohorts', title: 'Cohorts' },
  google: { adminEntity: 'driveAccount', title: 'Google account' },
  sheets: { adminEntity: 'sheetSync', title: 'Sheets' },
  students: { adminEntity: 'cohortMembers', title: 'Students in cohorts' },
  pathway: { adminEntity: 'pathway', title: 'Phases & milestones' },
  email: { adminEntity: 'emailNotifications', title: 'Email notifications' },
  'student-tasks': { adminEntity: 'studentTasks', title: 'Student Tasks' },
  'student-users': { adminEntity: 'studentUsers', title: 'Student users' },
  'staff-users': { adminEntity: 'staffUsers', staffPane: 'records', title: 'Staff users' },
  quotas: { adminEntity: 'staffUsers', staffPane: 'quotas', title: 'EE quotas' },
  subjects: { adminEntity: 'subjects', title: 'Subjects' },
  forms: { adminEntity: 'formDesigner', title: 'Milestone forms' },
  resources: { adminEntity: 'resources', title: 'Resources' },
  faqs: { adminEntity: 'faqs', title: 'FAQs' },
  categories: { adminEntity: 'ticketCategories', title: 'Message categories' },
  assignments: { adminEntity: 'studentTasks', title: 'Student Tasks' },
};

const ALLOCATION_VIEWS = {
  dashboard: { title: 'Allocation' },
  tokens: { title: 'Cohort tokens' },
  settings: { title: 'Student data' },
};

let historyMode = 'replace';
let historyInstalled = false;

export function sectionTabs(user, actingAs) {
  const student = !!(user && user.role === 'student');
  const permissions = (user && user.permissions) || {};
  const tabs = student
    ? [['document', 'Document'], ['journey', 'Journey'], ['supervisor', 'Supervisor']]
    : [['students', 'My Students'], ['resources', 'Resources']];
  if (!student && (actingAs === 'supervisor' || actingAs === 'coordinator') && (permissions.isSupervisor || permissions.canAdmin)) {
    tabs.splice(1, 0, ['tickets', 'Messages']);
  }
  if (!student && (permissions.isSupervisor || permissions.canAdmin)) {
    const notesAt = tabs.some(function(tab) { return tab[0] === 'tickets'; }) ? 2 : 1;
    tabs.splice(notesAt, 0, ['notes', 'Notes']);
  }
  if (permissions.canAdmin) tabs.push(['allocation', 'Allocation'], ['admin', 'Admin']);
  return tabs;
}

export function normalizePath(pathname) {
  let path = pathname || '/';
  try { path = decodeURI(path); } catch (error) { /* keep the raw path */ }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

export function matchPath(pathname) {
  const path = normalizePath(pathname);
  if (path === '/') return null;
  if (path === '/allocation') return { section: 'allocation', allocationView: 'dashboard' };
  if (path === '/allocation/tokens') return { section: 'allocation', allocationView: 'tokens' };
  if (path === '/allocation/settings') return { section: 'allocation', allocationView: 'settings' };
  if (path === '/admin/allocation-settings') return { section: 'allocation', allocationView: 'settings' };
  if (path === '/admin') return { section: 'admin', adminEntity: 'cohorts', panel: 'cohorts' };
  if (path.indexOf('/admin/') === 0) {
    const panel = path.slice('/admin/'.length);
    const spec = panel.indexOf('/') === -1 ? ADMIN_PANELS[panel] : null;
    if (!spec) return null;
    return { section: 'admin', adminEntity: spec.adminEntity, staffPane: spec.staffPane || '', panel: panel };
  }
  const section = SECTION_SLUGS[path.slice(1)];
  if (section && path.indexOf('/', 1) === -1) return { section: section };
  return null;
}

export function pathFromState(appState) {
  const section = appState.section;
  if (section === 'admin') {
    if (appState.adminEntity === 'staffUsers' && appState.staffPane === 'quotas') return '/admin/quotas';
    const panels = Object.keys(ADMIN_PANELS);
    for (let index = 0; index < panels.length; index += 1) {
      const panel = panels[index];
      if (panel === 'quotas') continue;
      if (ADMIN_PANELS[panel].adminEntity === appState.adminEntity) return '/admin/' + panel;
    }
    return '/admin/cohorts';
  }
  if (section === 'allocation') {
    if (appState.allocationView === 'tokens') return '/allocation/tokens';
    if (appState.allocationView === 'settings') return '/allocation/settings';
    return '/allocation';
  }
  if (section === 'journey' && appState.studentFocus === 'research' && appState.user && appState.user.role === 'student') return '/resources';
  const slugs = Object.keys(SECTION_SLUGS);
  for (let index = 0; index < slugs.length; index += 1) {
    if (SECTION_SLUGS[slugs[index]] === section) return '/' + slugs[index];
  }
  return appState.user && appState.user.role === 'student' ? '/journey' : '/my-students';
}

export function fallbackSection(appState) {
  if (appState.user && appState.user.role === 'student') return 'journey';
  const tabs = sectionTabs(appState.user, appState.actingAs);
  return tabs.length ? tabs[0][0] : 'students';
}

export function titleForState(appState) {
  if (!appState.user) return 'Sign in · EE Hub';
  if (appState.section === 'admin') {
    if (appState.adminEntity === 'staffUsers' && appState.staffPane === 'quotas') return 'EE quotas · EE Hub';
    const panels = Object.keys(ADMIN_PANELS);
    for (let index = 0; index < panels.length; index += 1) {
      const panel = panels[index];
      if (panel !== 'quotas' && ADMIN_PANELS[panel].adminEntity === appState.adminEntity) return ADMIN_PANELS[panel].title + ' · EE Hub';
    }
    return 'Admin · EE Hub';
  }
  if (appState.section === 'allocation') {
    const view = ALLOCATION_VIEWS[appState.allocationView] || ALLOCATION_VIEWS.dashboard;
    return view.title + ' · EE Hub';
  }
  return (SECTION_TITLES[appState.section] || 'EE Hub') + ' · EE Hub';
}

function sectionAllowed(appState, section) {
  if (!appState.user || !section) return false;
  return sectionTabs(appState.user, appState.actingAs).some(function(tab) { return tab[0] === section; });
}

export function applyRoute(route, appState) {
  const student = !!(appState.user && appState.user.role === 'student');
  if (route && route.section === 'resources' && student) {
    appState.section = 'journey';
    appState.view = 'journey';
    appState.studentFocus = 'research';
    return;
  }
  const allowed = route && sectionAllowed(appState, route.section);
  if (!allowed) {
    const section = fallbackSection(appState);
    appState.section = section;
    appState.view = section;
    appState.studentFocus = '';
    return;
  }
  appState.section = route.section;
  appState.view = route.section;
  appState.studentFocus = '';
  if (route.section === 'admin') {
    appState.adminEntity = route.adminEntity;
    if (route.panel === 'quotas') appState.staffPane = 'quotas';
    else if (route.panel === 'staff-users') appState.staffPane = 'records';
  }
  if (route.section === 'allocation') appState.allocationView = route.allocationView || 'dashboard';
}

export function applyLocation() {
  applyRoute(matchPath(window.location.pathname), state);
}

export const PROVISIONING_LEAVE_WARNING = 'Google Workspace provisioning is currently in progress. Leaving this page will stop the process. Are you sure you want to leave?';

let beforeUnloadInstalled = false;

export function provisioningBeforeUnload(event) {
  if (!state.isProvisioning) return;
  if (event) {
    event.preventDefault();
    event.returnValue = PROVISIONING_LEAVE_WARNING;
  }
  return PROVISIONING_LEAVE_WARNING;
}

export function installProvisioningLeaveGuard() {
  if (beforeUnloadInstalled) return;
  const host = globalThis.window;
  if (!host || typeof host.addEventListener !== 'function') return;
  beforeUnloadInstalled = true;
  host.addEventListener('beforeunload', provisioningBeforeUnload);
}

function dismissProvisioningModal() {
  const doc = globalThis.document;
  if (!doc || typeof doc.getElementById !== 'function') return;
  const modal = doc.getElementById('provision-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.innerHTML = '';
  modal.onclick = null;
}

export function confirmProvisioningLeave() {
  if (!state.isProvisioning) return true;
  const ask = globalThis.confirm;
  if (typeof ask !== 'function') return true;
  if (!ask(PROVISIONING_LEAVE_WARNING)) return false;
  state.provisionRun += 1;
  state.isProvisioning = false;
  state.driveBusy = false;
  dismissProvisioningModal();
  return true;
}

export function requestPush() {
  if (!confirmProvisioningLeave()) return false;
  historyMode = 'push';
  return true;
}

export function syncHistory() {
  if (!state.user) return;
  const path = pathFromState(state);
  const title = titleForState(state);
  document.title = title;
  const next = path + window.location.search + window.location.hash;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next !== current) {
    const data = { eeHub: path };
    if (historyMode === 'push') window.history.pushState(data, '', next);
    else window.history.replaceState(data, '', next);
  }
  historyMode = 'replace';
}

export function installHistory(onNavigate) {
  if (historyInstalled) return;
  historyInstalled = true;
  installProvisioningLeaveGuard();
  window.addEventListener('popstate', function() {
    if (!state.user) return;
    if (!confirmProvisioningLeave()) {
      const path = pathFromState(state);
      window.history.pushState({ eeHub: path }, '', path + window.location.search + window.location.hash);
      return;
    }
    historyMode = 'pop';
    applyLocation();
    onNavigate();
  });
}
