import { dispatchServer } from '../shared/api.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { isStale, sameScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { requestPush } from '../router.js';
import { renderShell } from '../navigation.js';
import { paintStudentJourney } from './journey.js';

export function loadStudentHome() {
  if (state.studentHome) return Promise.resolve(state.studentHome);
  if (!state.studentHomeRequest) {
    state.studentHomeRequest = dispatchServer('getStudentHome', []).then(function(home) {
      state.studentHome = home;
      return home;
    }).finally(function() {
      state.studentHomeRequest = null;
    });
  }
  return state.studentHomeRequest;
}

export function setJourneyOpen(open) {
  state.journeyOpen = !!open;
  document.body.classList.toggle('journey-open', state.journeyOpen);
  const panel = document.getElementById('journey-panel');
  if (panel) panel.classList.toggle('open', state.journeyOpen);
  const toggle = document.getElementById('journey-toggle');
  const peek = document.getElementById('journey-peek');
  if (toggle) toggle.setAttribute('aria-expanded', state.journeyOpen ? 'true' : 'false');
  if (peek) peek.setAttribute('aria-expanded', state.journeyOpen ? 'true' : 'false');
  const drawer = document.getElementById('journey-drawer');
  if (drawer) {
    drawer.setAttribute('aria-hidden', state.journeyOpen ? 'false' : 'true');
    if (state.journeyOpen) drawer.removeAttribute('inert');
    else drawer.setAttribute('inert', '');
  }
}

export function mountJourneyPanel() {
  const body = document.getElementById('journey-body');
  if (!body) return;
  if (state.user.role !== 'student' && state.staffStudentHome) {
    paintStudentJourney(state.staffStudentHome);
    return;
  }
  if (!state.studentHome) body.innerHTML = loadingLine('Loading your journey...');
  const scene = state.scene;
  loadStudentHome().then(function(home) {
    if (!sameScene(scene) || !document.getElementById('journey-body')) return;
    paintStudentJourney(home);
  }).catch(function(error) {
    if (isStale(error)) return;
    const target = document.getElementById('journey-body');
    if (target) target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
  });
}

let repaintImpl = null;

export function setStudentRepaint(fn) {
  repaintImpl = fn;
}

export function paintStudentPage(home) {
  if (repaintImpl) {
    repaintImpl(home);
    return;
  }
  const main = document.getElementById('main');
  if (main) main.innerHTML = loadingLine('Loading your EE...');
}

/** Students change route. Staff preview switches the in-page view and does not write a student view event. */
export function openStudentSection(section) {
  if (state.user && state.user.role !== 'student') {
    state.staffPreviewView = section;
    if (repaintImpl && state.staffStudentHome) repaintImpl(state.staffStudentHome);
    else if (section === 'journey') setJourneyOpen(true);
    return;
  }
  if (!requestPush()) return;
  state.studentFocus = '';
  state.section = section;
  state.view = section;
  renderShell();
}

export function renderStudentView() {
  openStudentSection('journey');
}

export function nextIncomplete(home) {
  const byTemplate = {};
  (home.actionItems || []).forEach(function(item) {
    if (item.CreatorType === 'System') byTemplate[item.TemplateId] = item;
  });
  for (let index = 0; index < home.templates.length; index++) {
    const template = home.templates[index];
    const item = byTemplate[template.milestoneId];
    if (!item || item.Status !== 'Completed') return { template: template, item: item || null };
  }
  return null;
}

export function systemItemFor(home, milestoneId) {
  return (home.actionItems || []).filter(function(entry) {
    return entry.CreatorType === 'System' && entry.TemplateId === milestoneId;
  })[0] || null;
}

export function milestonePhaseId(template, item) {
  return (item && item.PhaseId) || (template && template.phase) || '';
}

export function milestoneTitleText(template, item) {
  return (item && item.Title) || (template && template.title) || (template && template.milestoneId) || 'Milestone';
}

export function milestoneDescriptionText(template, item) {
  if (item) return item.Description || '';
  return (template && template.description) || '';
}

export function pencilIcon() {
  return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.2 1.6 14.4 4.8 5.2 14H2v-3.2zM3.1 11.9l.3 1.7 1.7.3 6.7-6.7-2-2z"/></svg>';
}

export function milestoneEditButton(home, item, title, template) {
  if (!home || !home.canUpdateMilestones) return '';
  const taskId = item && item.TaskId ? item.TaskId : '';
  const milestoneId = (template && template.milestoneId) || (item && item.TemplateId) || '';
  if (!taskId && !milestoneId) return '';
  return `<button type="button" class="icon-button" data-edit-milestone="${escapeHtml(taskId)}" data-milestone-id="${escapeHtml(milestoneId)}" aria-label="${escapeHtml('Edit ' + title)}">${pencilIcon()}</button>`;
}

export function staffStudentBar(home) {
  if (!home || !home.staffView) return '';
  return `<button type="button" class="link-button back" id="staff-back">← My Students</button>
    <p class="muted">${escapeHtml(home.hrm || '')}${home.studentNumber ? ' · Student Number ' + escapeHtml(home.studentNumber) : ''}${home.viewLabel ? ' · ' + escapeHtml(home.viewLabel) : ''}</p>`;
}

export function bindStaffStudentChrome() {
  const back = document.getElementById('staff-back');
  if (back) back.addEventListener('click', function() {
    state.staffStudent = null;
    state.staffStudentHome = null;
    state.journeyOpen = false;
    state.notesOpen = false;
    state.staffPreviewView = 'document';
    renderShell();
  });
}

export function renderUnreadNotices(tickets) {
  const items = tickets || [];
  if (!items.length) return '';
  return `<section class="notice-list" aria-label="Unread messages"><h2>Unread messages</h2><ul>${items.map(function(ticket) {
    const detail = [ticket.displayName, ticket.category === 'Note' ? '' : ticket.category].filter(Boolean).join(' · ');
    return `<li><button type="button" data-open-unread="${escapeHtml(ticket.ticketId)}"><strong>${escapeHtml(ticket.title || 'Message')}</strong>${detail ? `<span class="muted">${escapeHtml(detail)}</span>` : ''}</button></li>`;
  }).join('')}</ul></section>`;
}

export function bindUnreadNotices(main, staff) {
  main.querySelectorAll('[data-open-unread]').forEach(function(button) {
    button.addEventListener('click', function() {
      if (!requestPush()) return;
      state.focusTicket = button.dataset.openUnread;
      state.staffStudent = null;
      state.staffStudentHome = null;
      state.journeyOpen = false;
      state.studentFocus = '';
      state.section = staff ? 'tickets' : 'supervisor';
      renderShell();
    });
  });
}

export function formButton(home, next) {
  if (home.staffView) {
    if (!next || !next.template) return '';
    if (next.template.type === 'form') return `<button type="button" class="button secondary" data-view-response="${escapeHtml(next.template.milestoneId)}">View form</button>`;
    if (next.item && next.item.canUpdate) return '<button type="button" class="button secondary" data-go-journey>Open journey</button>';
    return '<p>Waiting on ' + escapeHtml(next.template.mOwner) + '.</p>';
  }
  if (!next || !next.item || next.template.mOwner !== 'student') return next && next.template ? '<p>Waiting on ' + escapeHtml(next.template.mOwner) + '.</p>' : '';
  if (next.template.type === 'form') {
    if (home.publishedForms && home.publishedForms[next.template.milestoneId]) {
      const closed = next.item && next.item.formOpen === false;
      return `<button type="button" class="button" data-open-form="${escapeHtml(next.template.milestoneId)}">${closed ? 'View form' : 'Open form'}</button>`;
    }
    return '<p>Your coordinator has not published this form yet.</p>';
  }
  return '<button type="button" class="button secondary" data-go-journey>Open journey</button>';
}
