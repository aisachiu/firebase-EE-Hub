import { quietServer } from '../shared/api.js';
import { docChipMarkup, paintDocChips } from '../shared/docChip.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene, sameScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { paintStudentActivity } from './activity.js';
import {
  bindStaffStudentChrome,
  bindUnreadNotices,
  loadStudentHome,
  renderUnreadNotices,
  setStudentRepaint,
  staffStudentBar,
} from './home.js';
import { modules } from './modules/registry.js';
import { groupModules, modulesFor, pathwayStage } from './stage.js';

const VIEW_COPY = {
  document: {
    eyebrow: 'Document',
    title: 'Document',
    lede: 'Your essay Doc, Drive folder, and writing activity.',
  },
  journey: {
    eyebrow: 'Journey',
    title: 'Journey',
    lede: 'Milestones, deadlines, meeting notes, and research support.',
  },
  supervisor: {
    eyebrow: 'Supervisor',
    title: 'Supervisor',
    lede: 'Your supervisor and messages.',
  },
};

export function renderStudentSection() {
  advanceScene();
  const main = document.getElementById('main');
  const view = studentViewName(state.section);
  main.innerHTML = loadingLine(view === 'journey' ? 'Loading your journey...' : 'Loading your EE...');
  const scene = state.scene;
  loadStudentHome().then(function(home) {
    if (!sameScene(scene)) return;
    paintActiveStudentView(home, view);
  }).catch(function(error) {
    if (!sameScene(scene)) return;
    const target = document.getElementById('main');
    if (target) target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
  });
}

export function paintActiveStudentView(home, view) {
  const name = studentViewName(view || state.section);
  const main = document.getElementById('main');
  if (!main) return;
  main.classList.add('student-home');
  main.innerHTML = pageHtml(home, name, false);
  paintDocChips(home);
  mountComposed(main, home, name);
  bindUnreadNotices(main, false);
  const pending = recordStudentViewOpen(name, home);
  if (name === 'document') {
    const showActivity = function() { paintStudentActivity(home); };
    if (pending) {
      pending.then(function(wrote) {
        if (wrote) state.activityFeed = null;
        if (document.getElementById('my-activity')) showActivity();
      });
    } else showActivity();
  }
}

export function paintStaffPreview(home) {
  const name = studentViewName(state.staffPreviewView || 'document');
  const main = document.getElementById('main');
  if (!main) return;
  main.classList.add('student-home');
  main.innerHTML = pageHtml(home, name, true);
  mountComposed(main, home, name);
  bindStaffStudentChrome();
  bindPreviewSwitch(home);
  if (name === 'document') paintStudentActivity(home);
}

function pageHtml(home, view, staff) {
  const copy = VIEW_COPY[view] || VIEW_COPY.journey;
  const who = home && home.displayName ? escapeHtml(home.displayName) : 'Student';
  const cohort = home && home.cohort ? `<p class="muted">${who}${home.cohort ? ' · Cohort ' + escapeHtml(home.cohort) : ''}</p>` : `<p class="muted">${who}</p>`;
  const returned = view !== 'supervisor' ? returnedNotice(home) : '';
  const notices = renderUnreadNotices(home && home.unreadTickets);
  const switcher = staff ? previewSwitcher(view) : '';
  const chips = staff ? docChipMarkup(home) : '';
  const activity = view === 'document' ? '<section class="section-gap" id="my-activity" aria-label="Activity"></section>' : '';
  return `${staffStudentBar(home)}
    <div class="page-head"><div><p class="eyebrow">${escapeHtml(copy.eyebrow)}</p><h1>${escapeHtml(copy.title)}</h1><p class="lede">${escapeHtml(copy.lede)}</p>${cohort}</div><div class="page-actions">${switcher}${chips}</div></div>
    ${notices}
    ${returned}
    ${composeView(home, view)}
    ${activity}`;
}

function previewSwitcher(view) {
  return `<div class="view-toggle" role="group" aria-label="Student views">${['document', 'Document', 'journey', 'Journey', 'supervisor', 'Supervisor'].reduce(function(html, label, index, list) {
    if (index % 2) return html;
    const id = list[index];
    const text = list[index + 1];
    return html + `<button type="button" data-staff-preview="${id}" aria-pressed="${view === id ? 'true' : 'false'}">${text}</button>`;
  }, '')}</div>`;
}

function returnedNotice(home) {
  const returned = ((home && home.actionItems) || []).filter(function(item) {
    return item.returnedComment && item.Status !== 'Completed';
  })[0];
  if (!returned) return '';
  return `<div class="notice">Returned: ${escapeHtml(returned.Title)}. ${escapeHtml(returned.returnedComment)}</div>`;
}

export function composeView(home, view) {
  const stage = pathwayStage(home);
  const grouped = groupModules(modulesFor(view, stage));
  const primary = grouped.primary.map(function(entry) { return wrapModule(home, view, stage, entry); }).join('');
  const secondary = grouped.secondary.map(function(entry) { return wrapModule(home, view, stage, entry); }).join('');
  return `<div class="student-view" data-student-view="${escapeHtml(view)}" data-stage="${escapeHtml(stage)}"><div class="view-columns"><div class="view-primary">${primary}</div>${secondary ? `<div class="view-secondary">${secondary}</div>` : ''}</div></div>`;
}

function wrapModule(home, view, stage, entry) {
  const mod = modules[entry.id];
  if (!mod || typeof mod.render !== 'function') return '';
  const html = mod.render(home, { slot: entry.slot, stage: stage, view: view });
  return `<section class="need-module slot-${escapeHtml(entry.slot || 'secondary')}" data-module="${escapeHtml(entry.id)}" data-slot="${escapeHtml(entry.slot || '')}">${html}</section>`;
}

function mountComposed(main, home, view) {
  const stage = pathwayStage(home);
  modulesFor(view, stage).forEach(function(entry) {
    if (entry.slot === 'hidden') return;
    const mod = modules[entry.id];
    const host = main.querySelector('[data-module="' + entry.id + '"]');
    if (mod && host && typeof mod.mount === 'function') mod.mount(host, home, { slot: entry.slot, stage: stage, view: view });
  });
}

function bindPreviewSwitch(home) {
  document.querySelectorAll('[data-staff-preview]').forEach(function(button) {
    button.addEventListener('click', function() {
      const next = button.dataset.staffPreview;
      if (!next || next === (state.staffPreviewView || 'document')) return;
      state.staffPreviewView = next;
      paintStaffPreview(home);
    });
  });
}

export function studentViewName(section) {
  if (section === 'document' || section === 'journey' || section === 'supervisor') return section;
  return 'journey';
}

/** Students only. Staff previews do not write these events. Returns a promise when a write was started. */
export function recordStudentViewOpen(view, home) {
  if (!home || home.staffView) return null;
  if (!state.user || state.user.role !== 'student') return null;
  if (state.loggedStudentView === view) return null;
  state.loggedStudentView = view;
  return quietServer('recordStudentView', [view]).then(function() {
    return true;
  }).catch(function() {
    if (state.loggedStudentView === view) state.loggedStudentView = '';
    return false;
  });
}

setStudentRepaint(function(home) {
  if (home && home.staffView) paintStaffPreview(home);
  else paintActiveStudentView(home, state.section);
});
