import { paintTabDot, setShellRenderer } from './navigation.js';
import { callServer, paintRequestIndicator } from './shared/api.js';
import { rememberOpeningMessages } from './shared/desk.js';
import { showFatal } from './shared/feedback.js';
import { ensureHeaderCohorts, headerCohortOptions } from './shared/headerCohorts.js';
import { escapeHtml } from './shared/html.js';
import { loadingLine, rememberQuotes } from './shared/loading.js';
import { advanceScene } from './shared/scene.js';
import { closeOpenMemberEditor, hideListJourneyTip } from './shared/sessionChrome.js';
import { actingAsOptions } from './shared/staffContext.js';
import { state } from './shared/state.js';
import { staffStudentDrawersHtml } from './shared/studentDrawers.js';
import { docChipMarkup } from './shared/docChip.js';
import { applyLocation, confirmProvisioningLeave, fallbackSection, installHistory, requestPush, sectionTabs, syncHistory } from './router.js';

export let booted = false;

export function start() {
  installHistory(function() { renderShell(); });
  const ready = window.eeAuthReady || Promise.resolve(window.eeUser || null);
  ready.then(function() {
    window.eeOnAuth = function(user) {
      if (user && !booted) bootHub();
    };
    if (!window.eeUser) showSignIn();
    else bootHub();
  });
}

export function showSignIn() {
  const demos = window.eeDemoAccounts || [];
  const demoHtml = demos.length
    ? '<div class="toolbar">' + demos.map(function(account) {
        return '<button type="button" class="button secondary" data-demo="' + escapeHtml(account.email) + '">' + escapeHtml(account.label) + '</button>';
      }).join('') + '</div><p class="muted">These demo accounts exist only when the local emulators are running.</p>'
    : '';
  document.title = 'Sign in · EE Hub';
  document.getElementById('app').innerHTML = '<div class="shell"><p class="eyebrow">VSA EE Hub</p><h1>Sign in</h1><p class="lede">Use your school Google account. Your email must already be on the staff or student list.</p><p><button type="button" class="button" id="google-sign-in">Sign in with Google</button></p>' + demoHtml + '</div>';
  document.getElementById('google-sign-in').addEventListener('click', function() {
    window.eeSignIn().catch(function(error) { showFatal('Sign-in failed', error.message || 'Google sign-in did not complete.'); });
  });
  document.querySelectorAll('[data-demo]').forEach(function(button) {
    button.addEventListener('click', function() {
      window.eeSignInDemo(button.dataset.demo).catch(function(error) { showFatal('Sign-in failed', error.message || 'Demo sign-in did not complete.'); });
    });
  });
}

export function bootHub() {
  if (booted) return;
  booted = true;
  callServer('getAppBootstrap').then(function(result) {
    rememberQuotes(result);
    if (!result || !result.user) {
      showFatal('Access unavailable', 'Your signed-in account is not registered in the EE Hub.');
      return;
    }
    state.user = result.user;
    rememberOpeningMessages(result.messages);
    state.view = state.user.role === 'student' ? 'journey' : 'students';
    state.section = state.view;
    if (state.user.permissions && state.user.permissions.canAdmin) state.actingAs = 'coordinator';
    else if (state.user.permissions && state.user.permissions.isSupervisor) state.actingAs = 'supervisor';
    else state.actingAs = 'staff';
    applyLocation();
    renderShell();
  }).catch(function(error) {
    booted = false;
    showFatal('Unable to start', error.message || 'The application could not reach the EE Hub.');
  });
}

const chunkCache = Object.create(null);
let shellRender = 0;

const chunkLoaders = {
  coordinator: function() { return import('./admin/coordinator.js'); },
  resources: function() { return import('./shared/resources.js'); },
  tickets: function() { return import('./staff/messages.js'); },
  notes: function() { return import('./staff/notes.js'); },
  home: function() { return import('./student/home.js'); },
  studentViews: function() { return import('./student/views.js'); },
  staff: function() { return import('./staff/students.js'); },
};

function cachedChunk(name) {
  const current = chunkCache[name];
  if (!current) {
    chunkCache[name] = chunkLoaders[name]().then(function(mod) {
      chunkCache[name] = mod;
      return mod;
    }, function(error) {
      delete chunkCache[name];
      throw error;
    });
  }
  return Promise.resolve(chunkCache[name]);
}

function readyChunk(name) {
  const current = chunkCache[name];
  if (!current || typeof current.then === 'function') return null;
  return current;
}

function sectionChunk(section, student) {
  if (section === 'admin' || section === 'allocation') return 'coordinator';
  if (section === 'resources') return 'resources';
  if (section === 'help' || section === 'document' || section === 'journey' || section === 'supervisor') return 'studentViews';
  if (section === 'tickets') return 'tickets';
  if (section === 'notes') return 'notes';
  return student ? 'studentViews' : 'staff';
}

function paintSection(mod) {
  const student = state.user.role === 'student';
  if (state.section === 'admin') mod.renderAdmin();
  else if (state.section === 'allocation') mod.renderAllocation();
  else if (state.section === 'resources') mod.renderResources();
  else if (state.section === 'document' || state.section === 'journey' || state.section === 'supervisor' || state.section === 'help') mod.renderStudentSection();
  else if (state.section === 'tickets') mod.renderStaffTickets();
  else if (state.section === 'notes') mod.renderStaffNotes();
  else if (student) mod.renderStudentSection();
  else mod.renderStaffHome();
}

function bindJourneyChrome(homeMod) {
  const journeyToggle = document.getElementById('journey-toggle');
  const journeyPeek = document.getElementById('journey-peek');
  const journeyClose = document.getElementById('journey-close');
  if (journeyToggle) journeyToggle.addEventListener('click', function() { homeMod.setJourneyOpen(!state.journeyOpen); });
  if (journeyPeek) journeyPeek.addEventListener('click', function() {
    homeMod.setJourneyOpen(true);
    const closeButton = document.getElementById('journey-close');
    if (closeButton) closeButton.focus();
  });
  if (journeyClose) journeyClose.addEventListener('click', function() {
    homeMod.setJourneyOpen(false);
    const peek = document.getElementById('journey-peek');
    if (peek) peek.focus();
  });
  homeMod.mountJourneyPanel();
}

function bindNotesChrome(notesMod) {
  const notesToggle = document.getElementById('notes-toggle');
  const notesPeek = document.getElementById('notes-peek');
  const notesClose = document.getElementById('notes-close');
  if (notesToggle) notesToggle.addEventListener('click', function() { notesMod.setNotesOpen(!state.notesOpen); });
  if (notesPeek) notesPeek.addEventListener('click', function() {
    notesMod.setNotesOpen(true);
    const closeButton = document.getElementById('notes-close');
    if (closeButton) closeButton.focus();
  });
  if (notesClose) notesClose.addEventListener('click', function() {
    notesMod.setNotesOpen(false);
    const peek = document.getElementById('notes-peek');
    if (peek) peek.focus();
  });
  notesMod.mountNotesPanel();
}

export function renderShell() {
  const renderId = ++shellRender;
  closeOpenMemberEditor();
  hideListJourneyTip();
  advanceScene();
  const student = state.user.role === 'student';
  if (!student && state.messageDesks[state.actingAs]) {
    state.staffTicketUnread = state.messageDesks[state.actingAs].unreadCount || 0;
    state.ticketBadgeFor = state.actingAs;
  }
  const staffJourney = !student && state.section === 'students' && !!state.staffStudentHome;
  const showJourney = staffJourney;
  const showNotes = staffJourney;
  const tabs = sectionTabs(state.user, state.actingAs);
  if (!tabs.some(function(tab) { return tab[0] === state.section; })) state.section = fallbackSection(state);
  state.view = state.section;
  if (state.section !== 'allocation' && typeof window.eeReleaseAllocationWatch === 'function') {
    window.eeReleaseAllocationWatch();
  }
  document.body.classList.toggle('has-journey', showJourney);
  document.body.classList.toggle('journey-open', showJourney && state.journeyOpen);
  document.body.classList.toggle('has-notes', showNotes);
  document.body.classList.toggle('notes-open', showNotes && state.notesOpen);
  document.body.classList.toggle('student-drawers', showNotes);
  const allocationDrawer = state.section === 'allocation' && state.allocationView !== 'settings' && state.allocationView !== 'tokens';
  document.body.classList.toggle('has-alloc-drawer', allocationDrawer);
  document.body.classList.toggle('alloc-drawer-open', allocationDrawer && state.allocationDrawerOpen === true);
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">EE</span><span>EE Hub</span>${student ? '' : '<span class="staff-pill">Staff</span>'}</div>
      <nav class="tabs" aria-label="Sections">${tabs.map(function(tab) {
        return `<button type="button" data-view="${tab[0]}" aria-current="${state.section === tab[0] ? 'page' : 'false'}">${tabLabel(tab)}</button>`;
      }).join('')}</nav>
      <div class="account">${headerContextMarkup()}${student ? docChipMarkup(state.studentHome) : ''}${showNotes ? `<button type="button" class="journey-toggle" id="notes-toggle" aria-expanded="${state.notesOpen ? 'true' : 'false'}" aria-controls="notes-panel">Notes</button>` : ''}${showJourney ? `<button type="button" class="journey-toggle" id="journey-toggle" aria-expanded="${state.journeyOpen ? 'true' : 'false'}" aria-controls="journey-panel">${showNotes ? 'Student Journey' : 'Journey'}</button>` : ''}<span id="request-indicator" class="request-indicator" aria-live="polite" aria-busy="false"></span><div>${escapeHtml(state.user.displayName)} <button type="button" id="sign-out" style="margin-left:8px;border:0;background:transparent;color:#e8f0f5;font-weight:700;">Sign out</button></div></div>
    </header>
    <div id="feedback-region" aria-live="polite"></div>
    ${showNotes ? staffStudentDrawersHtml({ journeyOpen: state.journeyOpen, notesOpen: state.notesOpen }) : ''}
    <main id="main"></main>
    ${showJourney && !showNotes ? `<aside id="journey-panel" class="journey-panel${state.journeyOpen ? ' open' : ''}" aria-label="Journey and to-dos">
      <button type="button" class="journey-peek" id="journey-peek" aria-expanded="${state.journeyOpen ? 'true' : 'false'}" aria-controls="journey-drawer">Journey</button>
      <div class="journey-drawer" id="journey-drawer"${state.journeyOpen ? '' : ' inert'} aria-hidden="${state.journeyOpen ? 'false' : 'true'}">
        <div class="journey-panel-bar"><strong>Journey</strong><button type="button" id="journey-close">Close</button></div>
        <div id="journey-body" class="journey-scroll"></div>
      </div>
    </aside>` : ''}
    <div id="form-dialog" class="form-dialog" hidden></div>`;
  bindHeaderContext();
  const signOutButton = document.getElementById('sign-out');
  if (signOutButton) signOutButton.addEventListener('click', function() {
    if (!confirmProvisioningLeave()) return;
    const done = window.eeSignOut ? window.eeSignOut() : Promise.resolve();
    done.then(function() { window.location.reload(); });
  });
  document.querySelectorAll('[data-view]').forEach(function(button) {
    button.addEventListener('click', function() {
      if (!requestPush()) return;
      state.section = button.dataset.view;
      state.view = state.section;
      state.studentFocus = '';
      state.emailDesk = false;
      state.noticeEdit = null;
      state.selectedStudent = null;
      state.staffStudent = null;
      state.staffStudentHome = null;
      state.journeyOpen = false;
      state.notesOpen = false;
      state.status = '';
      renderShell();
    });
  });
  const chunkName = sectionChunk(state.section, student);
  const sectionMod = readyChunk(chunkName);
  const homeMod = showJourney ? readyChunk('home') : null;
  const notesMod = showNotes ? readyChunk('notes') : null;
  const waiting = [];
  if (!sectionMod) waiting.push(cachedChunk(chunkName));
  if (showJourney && !homeMod) waiting.push(cachedChunk('home'));
  if (showNotes && !notesMod) waiting.push(cachedChunk('notes'));
  if (sectionMod) paintSection(sectionMod);
  else document.getElementById('main').innerHTML = loadingLine('Loading...');
  if (homeMod) bindJourneyChrome(homeMod);
  if (notesMod) bindNotesChrome(notesMod);
  if (waiting.length) {
    Promise.all(waiting).then(function() {
      if (renderId !== shellRender) return;
      if (!sectionMod) paintSection(readyChunk(chunkName));
      if (showJourney && !homeMod) bindJourneyChrome(readyChunk('home'));
      if (showNotes && !notesMod) bindNotesChrome(readyChunk('notes'));
    }).catch(function(error) {
      if (renderId !== shellRender) return;
      showFatal('Unable to open this section', error && error.message ? error.message : 'This section could not be loaded.');
    });
  }
  if (!student && tabs.some(function(tab) { return tab[0] === 'tickets'; }) && state.ticketBadgeFor !== state.actingAs && !state.messageDesks[state.actingAs]) {
    const requested = state.actingAs;
    state.ticketBadgeFor = requested;
    callServer('getStaffTicketBadge', requested).then(function(badge) {
      if (state.actingAs !== requested) return;
      state.staffTicketUnread = badge.unreadCount || 0;
      paintTabDot('tickets', state.staffTicketUnread, 'Messages');
    }).catch(function() { state.ticketBadgeFor = ''; });
  }
  syncHistory();
  ensureHeaderCohorts();
  paintRequestIndicator();
  syncTopbarHeight();
}

function syncTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  document.documentElement.style.setProperty('--topbar-height', bar.offsetHeight + 'px');
}

function headerContextMarkup() {
  if (!state.user || state.user.role === 'student') return '';
  const ready = !!(state.headerCohorts && state.headerCohorts.length);
  return `<div class="header-context"><label for="header-cohort">Cohort</label><select id="header-cohort"${ready ? '' : ' disabled'}>${headerCohortOptions()}</select><label for="header-acting-as">Acting as</label><select id="header-acting-as">${actingAsOptions(state.user, state.actingAs)}</select></div>`;
}

function bindHeaderContext() {
  const cohort = document.getElementById('header-cohort');
  const acting = document.getElementById('header-acting-as');
  if (cohort) cohort.addEventListener('change', function(event) {
    const next = event.target.value;
    if (!next || next === state.cohortId) return;
    if (!confirmProvisioningLeave()) {
      event.target.value = state.cohortId;
      return;
    }
    state.cohortId = next;
    state.allocationSelected = [];
    state.allocationSubjects = {};
    state.allocationSubjectFilter = [];
    state.allocationAllocatedFilter = [];
    state.allocationTeacherFilter = [];
    state.allocationSupportFlags = [];
    state.allocationCustomFilters = {};
    state.allocationQuery = '';
    state.allocationCustomQueries = {};
    state.allocationCustomOpen = '';
    state.allocationOpenStudent = '';
    state.allocationAssignedOpen = {};
    state.allocationDataSelected = [];
    state.allocationInterdisciplinary = {};
    state.allocationInterdisciplinarySubject = {};
    state.tokenEditId = '';
    state.memberProvisionFilter = 'all';
    state.staffSupervisor = '';
    state.staffSelected = [];
    state.staffHome = null;
    state.staffStudent = null;
    state.staffStudentHome = null;
    renderShell();
  });
  if (acting) acting.addEventListener('change', function(event) {
    const next = event.target.value;
    if (!next || next === state.actingAs) return;
    if (!confirmProvisioningLeave()) {
      event.target.value = state.actingAs;
      return;
    }
    state.actingAs = next;
    state.staffSelected = [];
    state.staffHome = null;
    state.staffStudent = null;
    state.staffStudentHome = null;
    state.ticketBadgeFor = '';
    renderShell();
  });
}

export function tabLabel(tab) {
  const helpUnread = state.studentHome ? state.studentHome.unreadTicketCount : (state.messageDesks.student ? state.messageDesks.student.unreadCount : 0);
  if (tab[0] === 'supervisor' && helpUnread) return 'Supervisor<span class="dot" aria-label="Unread reply"></span>';
  if (tab[0] === 'tickets' && state.staffTicketUnread) return 'Messages<span class="dot" aria-label="Unread messages"></span>';
  return tab[1];
}

setShellRenderer(renderShell);
if (typeof window !== 'undefined') window.addEventListener('resize', syncTopbarHeight);
