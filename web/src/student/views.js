import { quietServer } from '../shared/api.js';
import { docChipMarkup, paintDocChips } from '../shared/docChip.js';
import { clampEePage } from '../shared/eePage.js';
import { escapeHtml, shortDate } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene, sameScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { paintStudentActivity } from './activity.js';
import { renderStudentHelp } from './help.js';
import {
  bindStaffStudentChrome,
  bindUnreadNotices,
  loadStudentHome,
  milestoneDescriptionText,
  milestonePhaseId,
  milestoneTitleText,
  nextIncomplete,
  renderUnreadNotices,
  setStudentRepaint,
  staffStudentBar,
} from './home.js';
import { mountCalendar } from './modules/calendar.js';
import { renderEssayEmbed } from './modules/document.js';
import { modules } from './modules/registry.js';
import { renderBooking } from './modules/supervisor.js';
import { bindEeStage, dateParts, EE_PAGES, pageTitle, previewPage, studentViewsForPage } from './rotary.js';
import { pathwayStage } from './stage.js';
import { paintStudentJourney } from './journey.js';

export function renderStudentSection() {
  if (state.section === 'help') {
    renderStudentHelp();
    return;
  }
  advanceScene();
  const main = document.getElementById('main');
  main.innerHTML = loadingLine('Loading your EE...');
  const scene = state.scene;
  loadStudentHome().then(function(home) {
    if (!sameScene(scene)) return;
    paintActiveStudentView(home);
  }).catch(function(error) {
    if (!sameScene(scene)) return;
    const target = document.getElementById('main');
    if (target) target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
  });
}

export function paintActiveStudentView(home) {
  const page = clampEePage(state.eePage);
  const main = document.getElementById('main');
  if (!main) return;
  main.classList.add('student-home', 'ee-stage-main');
  main.innerHTML = studentStageHtml(home, page, false);
  paintDocChips(home);
  mountStage(main, home, page, false);
}

export function paintStaffPreview(home) {
  const page = previewPage(state.staffPreviewView);
  const main = document.getElementById('main');
  if (!main) return;
  main.classList.add('student-home', 'ee-stage-main');
  main.innerHTML = studentStageHtml(home, page, true);
  mountStage(main, home, page, true);
  bindStaffStudentChrome();
  bindPreviewSwitch(home);
}

export function studentStageHtml(home, page, staff) {
  const index = staff ? previewPage(page) : clampEePage(page);
  const mobile = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
  return `${staffChrome(home, index)}
    <div class="ee-stage${mobile ? ' is-mobile' : ''}" data-ee-stage data-page="${index}">
      <div class="ee-page-chip" data-ee-chip aria-live="polite"><b>${index}</b> ${escapeHtml(pageTitle(index, mobile))}</div>
      <button type="button" class="ee-edge ee-edge-prev" data-ee-prev aria-label="Previous page">‹</button>
      <button type="button" class="ee-edge ee-edge-next" data-ee-next aria-label="Next page">›</button>
      <div class="ee-track" data-ee-track>
        <section class="ee-pane ee-pane-doc" data-ee-pane="doc">${documentPane(home, mobile)}</section>
        <section class="ee-pane ee-pane-journey" data-ee-pane="journey" aria-label="Journey and to-dos"><div id="ee-journey"></div></section>
        <section class="ee-pane ee-pane-cal" data-ee-pane="calendar" aria-label="Journey calendar"><div id="ee-calendar"></div></section>
        <section class="ee-pane ee-pane-meetings" data-ee-pane="meetings">${meetingsPane(home)}</section>
        <section class="ee-pane ee-pane-chat" data-ee-pane="chat">${modules.communication.render(home, { thread: true })}</section>
      </div>
    </div>`;
}

function staffChrome(home, page) {
  if (!home || !home.staffView) return '';
  return `<div class="ee-staff-bar">${staffStudentBar(home)}<div class="page-actions">${previewSwitcher(page)}${docChipMarkup(home)}</div></div>`;
}

function previewSwitcher(page) {
  const buttons = EE_PAGES.map(function(row) {
    return `<button type="button" data-staff-preview="${row.id}" aria-pressed="${page === row.id ? 'true' : 'false'}">${escapeHtml(row.title)}</button>`;
  }).join('');
  return `<div class="view-toggle ee-preview" role="group" aria-label="Student pages">${buttons}</div>`;
}

function documentPane(home, omitFrame) {
  const essay = modules.document.render(home, { slot: 'primary', view: 'my-ee' });
  return `<div class="ee-doc-scroll">
      <div class="ee-home-chrome">${identityHtml(home)}${nextMilestoneHtml(home)}${renderUnreadNotices(home && home.unreadTickets)}${returnedNotice(home)}</div>
      ${essay}
      ${renderEssayEmbed(home, { omitFrame: omitFrame })}
      <section class="section-gap ee-activity" id="my-activity" aria-label="Activity"></section>
    </div>`;
}

function identityHtml(home) {
  const name = (home && (home.supervisorName || home.supervisorId)) || 'Not assigned yet';
  const subject = (home && home.subject) || 'Subject not set';
  const stageName = pathwayStage(home);
  const stageLabel = stageName === 'mid' ? 'Mid' : (stageName === 'late' ? 'Late' : 'Early');
  const cohort = home && home.cohort ? 'Cohort ' + home.cohort : '';
  const chip = ['Pathway · ' + stageLabel, cohort].filter(Boolean).join(' · ');
  return `<section class="ee-identity" aria-label="Subject and supervisor"><div class="ee-who"><div class="ee-avatar" aria-hidden="true">${escapeHtml(initials(name))}</div><div><div class="ee-kicker">Supervisor</div><div class="ee-identity-name">${escapeHtml(name)}</div></div></div><div><div class="ee-kicker">EE subject</div><div class="ee-identity-name">${escapeHtml(subject)}</div></div>${chip ? `<span class="chip">${escapeHtml(chip)}</span>` : ''}</section>`;
}

function nextMilestoneHtml(home) {
  const next = home && home.templates ? nextIncomplete(home) : null;
  if (!next || !next.template) {
    return `<section class="ee-next" aria-label="Next journey milestone"><div><p class="eyebrow">Next milestone</p><h2>Official milestones are complete</h2><p>Open the journey if you still want to add a to-do.</p></div><button type="button" class="button secondary" data-open-ee-page="1">View journey</button></section>`;
  }
  const title = milestoneTitleText(next.template, next.item);
  const phase = phaseLabel(home, next);
  const due = next.item && next.item.DueDate ? shortDate(next.item.DueDate) : '';
  const detail = milestoneDescriptionText(next.template, next.item) || 'This is your next step.';
  const box = dateBox(next.item && next.item.DueDate);
  return `<section class="ee-next" aria-label="Next journey milestone">${box}<div><p class="eyebrow">Next milestone${phase ? ' · ' + escapeHtml(phase) : ''}</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>${due ? `<p>Due ${escapeHtml(due)}</p>` : ''}</div><button type="button" class="button secondary" data-open-ee-page="1">View journey</button></section>`;
}

function phaseLabel(home, next) {
  const phaseId = milestonePhaseId(next.template, next.item);
  const phases = (home && home.phases) || [];
  const index = phases.findIndex(function(phase) { return phase && phase.phaseId === phaseId; });
  if (index >= 0) return 'Phase ' + (index + 1);
  const match = phases.filter(function(phase) { return phase && phase.phaseId === phaseId; })[0];
  return match ? (match.phaseTitle || '') : '';
}

function dateBox(value) {
  const parts = dateParts(value);
  if (!parts) return '';
  return `<div class="ee-datebox" aria-hidden="true"><div class="ee-date-mo">${escapeHtml(parts.label)}</div><div class="ee-date-dy">${parts.day}</div><div class="ee-date-wd">${escapeHtml(parts.weekday)}</div></div>`;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0] === 'Not') return '·';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (parts[0][0] + last).toUpperCase();
}

function meetingsPane(home) {
  return `<div class="ee-meetings-scroll"><section class="need-module">${modules.supervisor.render(home)}</section>${renderBooking(home)}<section class="need-module">${modules.meetingNotes.render(home, { slot: 'secondary' })}</section></div>`;
}

function returnedNotice(home) {
  const returned = ((home && home.actionItems) || []).filter(function(item) {
    return item.returnedComment && item.Status !== 'Completed';
  })[0];
  if (!returned) return '';
  return `<div class="notice">Returned: ${escapeHtml(returned.Title)}. ${escapeHtml(returned.returnedComment)}</div>`;
}

function mountStage(main, home, page, staff) {
  const stage = main.querySelector('[data-ee-stage]');
  const docHost = main.querySelector('[data-module="document"], .ee-pane-doc');
  if (modules.document && docHost && typeof modules.document.mount === 'function') {
    modules.document.mount(docHost, home, { slot: 'primary', view: 'my-ee' });
  }
  const journey = main.querySelector('#ee-journey');
  if (journey) paintStudentJourney(home, journey);
  mountCalendar(main.querySelector('#ee-calendar'), home);
  const chat = main.querySelector('[data-ee-pane="chat"]');
  if (chat && modules.communication && typeof modules.communication.mount === 'function') {
    modules.communication.mount(chat, home, { thread: true });
  }
  paintStudentActivity(home);
  if (!staff) bindUnreadNotices(main, false);
  bindEeStage(stage, {
    page: page,
    onPage: function(next) { publishEePage(next, home, staff); },
  });
}

function publishEePage(page, home, staff) {
  if (staff) {
    state.staffPreviewView = String(page);
    return;
  }
  state.eePage = page;
  const path = '/my-ee' + (page ? '?page=' + page : '');
  const current = window.location.pathname + window.location.search;
  if (current !== path && window.history && typeof window.history.replaceState === 'function') {
    window.history.replaceState({ eeHub: '/my-ee' }, '', path);
  }
  studentViewsForPage(page).forEach(function(view) {
    const pending = recordStudentViewOpen(view, home);
    if (view === 'document' && page === 0 && pending) {
      pending.then(function(wrote) {
        if (!wrote) return;
        state.activityFeed = null;
        if (document.getElementById('my-activity')) paintStudentActivity(home);
      });
    }
  });
}

function bindPreviewSwitch(home) {
  document.querySelectorAll('[data-staff-preview]').forEach(function(button) {
    button.addEventListener('click', function() {
      const next = button.getAttribute('data-staff-preview');
      if (next === null || previewPage(next) === previewPage(state.staffPreviewView)) return;
      state.staffPreviewView = next;
      paintStaffPreview(home);
    });
  });
}

/** Students only. Staff previews do not write these events. Returns a promise when a write was started. */
export function recordStudentViewOpen(view, home) {
  if (!home || home.staffView) return null;
  if (!state.user || state.user.role !== 'student') return null;
  if (!state.loggedStudentViews) state.loggedStudentViews = {};
  if (state.loggedStudentViews[view]) return null;
  state.loggedStudentViews[view] = true;
  state.loggedStudentView = view;
  return quietServer('recordStudentView', [view]).then(function() {
    return true;
  }).catch(function() {
    if (state.loggedStudentViews) delete state.loggedStudentViews[view];
    return false;
  });
}

setStudentRepaint(function(home) {
  if (home && home.staffView) paintStaffPreview(home);
  else paintActiveStudentView(home);
});
