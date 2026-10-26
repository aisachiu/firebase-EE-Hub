import { closeMemberEditor } from './admin/records.js';
import { renderAdmin } from './admin/sections.js';
import { renderAllocation } from './allocation/desk.js';
import { callServer, paintRequestIndicator } from './shared/api.js';
import { rememberOpeningMessages } from './shared/desk.js';
import { showFatal } from './shared/feedback.js';
import { escapeHtml } from './shared/html.js';
import { rememberQuotes } from './shared/loading.js';
import { renderResources } from './shared/resources.js';
import { advanceScene } from './shared/scene.js';
import { actingAsOptions } from './shared/staffContext.js';
import { state } from './shared/state.js';
import { renderStaffTickets } from './staff/messages.js';
import { mountNotesPanel, renderStaffNotes, setNotesOpen } from './staff/notes.js';
import { hideListJourneyTip, renderStaffHome } from './staff/students.js';
import { applyLocation, installHistory, requestPush, sectionTabs, syncHistory } from './router.js';
import { renderStudentHelp } from './student/help.js';
import { mountJourneyPanel, renderStudentSection, setJourneyOpen } from './student/home.js';

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
    state.view = state.user.role === 'student' ? 'home' : 'students';
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

export function renderShell() {
  closeMemberEditor();
  hideListJourneyTip();
  advanceScene();
  const student = state.user.role === 'student';
  if (!student && state.messageDesks[state.actingAs]) {
    state.staffTicketUnread = state.messageDesks[state.actingAs].unreadCount || 0;
    state.ticketBadgeFor = state.actingAs;
  }
  const staffJourney = !student && state.section === 'students' && !!state.staffStudentHome;
  const showJourney = student || staffJourney;
  const showNotes = staffJourney;
  const tabs = sectionTabs(state.user, state.actingAs);
  if (!tabs.some(function(tab) { return tab[0] === state.section; })) state.section = tabs[0][0];
  state.view = state.section;
  document.body.classList.toggle('has-journey', showJourney);
  document.body.classList.toggle('journey-open', showJourney && state.journeyOpen);
  document.body.classList.toggle('has-notes', showNotes);
  document.body.classList.toggle('notes-open', showNotes && state.notesOpen);
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">EE</span><span>EE Hub</span>${student ? '' : '<span class="staff-pill">Staff</span>'}</div>
      <nav class="tabs" aria-label="Sections">${tabs.map(function(tab) {
        return `<button type="button" data-view="${tab[0]}" aria-current="${state.section === tab[0] ? 'page' : 'false'}">${tabLabel(tab)}</button>`;
      }).join('')}</nav>
      <div class="account">${headerContextMarkup()}${showNotes ? `<button type="button" class="journey-toggle" id="notes-toggle" aria-expanded="${state.notesOpen ? 'true' : 'false'}" aria-controls="notes-panel">Notes</button>` : ''}${showJourney ? `<button type="button" class="journey-toggle" id="journey-toggle" aria-expanded="${state.journeyOpen ? 'true' : 'false'}" aria-controls="journey-panel">Journey</button>` : ''}<span id="request-indicator" class="request-indicator" aria-live="polite" aria-busy="false"></span><div>${escapeHtml(state.user.displayName)} <button type="button" id="sign-out" style="margin-left:8px;border:0;background:transparent;color:#e8f0f5;font-weight:700;">Sign out</button></div></div>
    </header>
    <div id="feedback-region" aria-live="polite"></div>
    ${showNotes ? `<aside id="notes-panel" class="notes-panel${state.notesOpen ? ' open' : ''}" aria-label="Notes for this student">
      <button type="button" class="notes-peek" id="notes-peek" aria-expanded="${state.notesOpen ? 'true' : 'false'}" aria-controls="notes-drawer">Notes</button>
      <div class="notes-drawer" id="notes-drawer"${state.notesOpen ? '' : ' inert'} aria-hidden="${state.notesOpen ? 'false' : 'true'}">
        <div class="journey-panel-bar"><strong>Notes</strong><button type="button" id="notes-close">Close</button></div>
        <div id="notes-body" class="notes-scroll"></div>
      </div>
    </aside>` : ''}
    <main id="main"></main>
    ${showJourney ? `<aside id="journey-panel" class="journey-panel${state.journeyOpen ? ' open' : ''}" aria-label="Journey and to-dos">
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
    const done = window.eeSignOut ? window.eeSignOut() : Promise.resolve();
    done.then(function() { window.location.reload(); });
  });
  document.querySelectorAll('[data-view]').forEach(function(button) {
    button.addEventListener('click', function() {
      requestPush();
      state.section = button.dataset.view;
      state.view = state.section;
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
  if (state.section === 'admin') renderAdmin();
  else if (state.section === 'allocation') renderAllocation();
  else if (state.section === 'resources') renderResources();
  else if (state.section === 'help') renderStudentHelp();
  else if (state.section === 'tickets') renderStaffTickets();
  else if (state.section === 'notes') renderStaffNotes();
  else if (student) renderStudentSection();
  else renderStaffHome();
  if (showJourney) {
    const journeyToggle = document.getElementById('journey-toggle');
    const journeyPeek = document.getElementById('journey-peek');
    const journeyClose = document.getElementById('journey-close');
    if (journeyToggle) journeyToggle.addEventListener('click', function() { setJourneyOpen(!state.journeyOpen); });
    if (journeyPeek) journeyPeek.addEventListener('click', function() {
      setJourneyOpen(true);
      const closeButton = document.getElementById('journey-close');
      if (closeButton) closeButton.focus();
    });
    if (journeyClose) journeyClose.addEventListener('click', function() {
      setJourneyOpen(false);
      const peek = document.getElementById('journey-peek');
      if (peek) peek.focus();
    });
    mountJourneyPanel();
  }
  if (showNotes) {
    const notesToggle = document.getElementById('notes-toggle');
    const notesPeek = document.getElementById('notes-peek');
    const notesClose = document.getElementById('notes-close');
    if (notesToggle) notesToggle.addEventListener('click', function() { setNotesOpen(!state.notesOpen); });
    if (notesPeek) notesPeek.addEventListener('click', function() {
      setNotesOpen(true);
      const closeButton = document.getElementById('notes-close');
      if (closeButton) closeButton.focus();
    });
    if (notesClose) notesClose.addEventListener('click', function() {
      setNotesOpen(false);
      const peek = document.getElementById('notes-peek');
      if (peek) peek.focus();
    });
    mountNotesPanel();
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
}

let headerCohortsRequest = null;

function normalizeCohorts(cohorts) {
  return (cohorts || []).map(function(cohort) {
    return { id: cohort.id, name: cohort.name || cohort.id };
  }).filter(function(cohort) { return cohort.id; });
}

function headerCohortOptions() {
  const cohorts = state.headerCohorts;
  if (!cohorts) return '<option value="">Loading cohorts...</option>';
  if (!cohorts.length) return '<option value="">No cohorts</option>';
  return cohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name || cohort.id)}</option>`;
  }).join('');
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
    state.cohortId = next;
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
    state.actingAs = next;
    state.staffSelected = [];
    state.staffHome = null;
    state.staffStudent = null;
    state.staffStudentHome = null;
    state.ticketBadgeFor = '';
    renderShell();
  });
}

export function rememberHeaderCohorts(cohorts) {
  if (!Array.isArray(cohorts)) return;
  state.headerCohorts = normalizeCohorts(cohorts);
  paintHeaderCohortSelect();
}

export function paintHeaderCohortSelect() {
  const select = document.getElementById('header-cohort');
  if (!select || !state.user || state.user.role === 'student') return;
  const signature = (state.headerCohorts || []).map(function(cohort) { return cohort.id + '\0' + cohort.name; }).join('\n');
  if (select.dataset.cohorts !== signature) {
    select.dataset.cohorts = signature;
    select.innerHTML = headerCohortOptions();
  }
  select.disabled = !(state.headerCohorts && state.headerCohorts.length);
  if (state.cohortId) select.value = state.cohortId;
}

export function ensureHeaderCohorts() {
  if (!state.user || state.user.role === 'student') return;
  if (state.headerCohorts || headerCohortsRequest) return;
  headerCohortsRequest = callServer('getCohorts').then(function(cohorts) {
    if (!state.headerCohorts) state.headerCohorts = normalizeCohorts(cohorts);
    paintHeaderCohortSelect();
  }, function(error) {
    headerCohortsRequest = null;
    if (error && error.stale) ensureHeaderCohorts();
  });
}

export function tabLabel(tab) {
  const helpUnread = state.studentHome ? state.studentHome.unreadTicketCount : (state.messageDesks.student ? state.messageDesks.student.unreadCount : 0);
  if (tab[0] === 'help' && helpUnread) return 'Help<span class="dot" aria-label="Unread reply"></span>';
  if (tab[0] === 'tickets' && state.staffTicketUnread) return 'Messages<span class="dot" aria-label="Unread messages"></span>';
  return tab[1];
}

export function paintTabDot(view, count, label) {
  const button = document.querySelector('[data-view="' + view + '"]');
  if (!button) return;
  button.innerHTML = label + (count ? '<span class="dot" aria-label="Unread"></span>' : '');
}
