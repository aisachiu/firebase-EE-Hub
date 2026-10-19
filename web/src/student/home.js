import { callServer, dispatchServer } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { escapeHtml, formatCount, formatLastEdit, formatWordDelta, safeUrl } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene, isStale, sameScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { paintTabDot, renderShell } from '../shell.js';
import { formatActivityWhen, paintStudentActivity } from './activity.js';
import {
  applyJourneyHero,
  bindJourneyHero,
  journeyOverview,
  paintStudentJourney,
  renderJourneyHero,
} from './journey.js';
import { bindFormButtons } from './milestones.js';

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

export function renderStudentSection() {
  advanceScene();
  const main = document.getElementById('main');
  main.innerHTML = loadingLine('Loading your EE...');
  const scene = state.scene;
  loadStudentHome().then(function(home) {
    if (!sameScene(scene)) return;
    paintStudentPage(home);
  }).catch(showError);
}

export function renderStudentView() {
  setJourneyOpen(true);
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

export function milestoneEditButton(home, item, title) {
  if (!home || !home.canUpdateMilestones || !item || !item.TaskId) return '';
  return `<button type="button" class="icon-button" data-edit-milestone="${escapeHtml(item.TaskId)}" aria-label="${escapeHtml('Edit ' + title)}">${pencilIcon()}</button>`;
}

export function paintStudentPage(home) {
  const main = document.getElementById('main');
  main.classList.add('student-home');
  const next = nextIncomplete(home);
  const returned = (home.actionItems || []).filter(function(item) { return item.returnedComment && item.Status !== 'Completed'; })[0];
  const templates = home.templates || [];
  const meetings = templates.filter(function(template) { return template.type === 'meeting'; });
  const meetingDone = meetings.filter(function(template) {
    return (home.actionItems || []).some(function(item) { return item.TemplateId === template.milestoneId && item.Status === 'Completed'; });
  }).length;
  const done = (home.actionItems || []).filter(function(item) { return item.CreatorType === 'System' && item.Status === 'Completed'; }).length;
  const pageName = home.displayName || 'Student';
  const heroTitle = next ? milestoneTitleText(next.template, next.item) : '';
  const heroDescription = next ? (milestoneDescriptionText(next.template, next.item) || 'Complete this milestone before the due date.') : '';
  const hero = next ? `<section class="hero"><div><p class="eyebrow">${home.staffView ? 'Next step' : 'Your next step'}</p><h2>${escapeHtml(heroTitle)}</h2><p>${escapeHtml(heroDescription)}</p></div><div>${next.item && next.item.DueDate ? `<div class="chip">${escapeHtml(String(next.item.DueDate).slice(0, 10))}</div>` : ''}${formButton(home, next)}</div></section>` : '<section class="hero"><div><p class="eyebrow">All caught up</p><h2>No action needed right now</h2><p>Open Journey to see what is coming.</p></div></section>';
  main.innerHTML = `${staffStudentBar(home)}
    <div class="page-head"><div><h1>${escapeHtml(pageName)}'s EE</h1>${home.cohort ? `<p class="muted">Cohort ${escapeHtml(home.cohort)}</p>` : ''}</div></div>
    ${renderJourneyHero(journeyOverview(home))}
    ${hero}
    ${renderUnreadNotices(home.unreadTickets)}
    ${returned ? `<div class="notice">Returned: ${escapeHtml(returned.Title)}. ${escapeHtml(returned.returnedComment)}</div>` : ''}
    <div class="tiles">
      <div class="tile"><div class="muted">Milestones</div><div class="val">${done} <small>/ ${templates.length}</small></div></div>
      <div class="tile"><div class="muted">Sessions</div><div class="val">${meetingDone} <small>/ ${meetings.length}</small></div></div>
      <div class="tile"><div class="muted">Subject</div><div class="val" style="font-size:16px">${escapeHtml(home.subject || 'Not chosen')}</div></div>
      <div class="tile"><div class="muted">Anchor</div><div class="val" style="font-size:16px">${escapeHtml(home.anchor || '—')}</div></div>
    </div>
    <h2 class="section-gap">${home.staffView ? 'Documents' : 'My documents'}</h2>
    <div class="docs-layout">${renderFolderCard(home)}${renderEssayCard(home)}</div>
    <section class="section-gap" id="my-activity" aria-label="${home.staffView ? 'Student activity' : 'Your activity'}"></section>`;
  applyJourneyHero(main);
  bindJourneyHero(main);
  bindFormButtons(main);
  bindStaffStudentChrome();
  bindUnreadNotices(main, false);
  paintTabDot('help', home.unreadTicketCount, 'Help');
  paintEssayAnalytics(home);
  paintStudentActivity(home);
}

export function renderFolderCard(home) {
  const links = home.links || {};
  const folder = safeUrl(links.folder);
  const extras = [['RPPF', links.rppf], ['Poster', links.poster]].map(function(entry) {
    const url = safeUrl(entry[1]);
    return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry[0])}</a>` : `<span class="muted">${escapeHtml(entry[0])} not created yet</span>`}</li>`;
  }).join('');
  return `<article class="folder-card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg><h3>Drive folder</h3><p class="muted">${folder ? 'Shared with your supervisor.' : 'Not created yet.'}</p>${folder ? `<a href="${escapeHtml(folder)}" target="_blank" rel="noopener noreferrer">Open folder</a>` : ''}<ul class="folder-links">${extras}</ul></article>`;
}

export function renderEssayCard(home) {
  const url = safeUrl(home.links && home.links.doc);
  return `<article class="doc-dashboard"><div class="doc-head"><h3><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg><span id="essay-doc-title">Extended Essay</span></h3>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in Google Docs</a>` : ''}</div><div id="essay-stats">${url ? '<p class="muted">Reading the Google Doc…</p>' : '<p class="muted">Not created yet.</p>'}</div></article>`;
}

export function essayAnalyticsKey(home) {
  return (home.email || '') + '|' + ((home.links && home.links.doc) || '');
}

export function paintEssayAnalytics(home) {
  const host = document.getElementById('essay-stats');
  if (!host) return;
  const url = safeUrl(home.links && home.links.doc);
  if (!url) return;
  const key = essayAnalyticsKey(home);
  const cached = state.essayAnalytics;
  if (cached && cached.key === key && cached.stats && cached.stats.ok && Date.now() - cached.at < 600000) {
    host.innerHTML = renderEssayStats(cached.stats);
    const cachedTitle = document.getElementById('essay-doc-title');
    if (cachedTitle && cached.stats.title) cachedTitle.textContent = cached.stats.title;
    return;
  }
  const request = home.staffView
    ? callServer('getStudentEssayAnalytics', home.email, home.cohort || '', home.viewAs || state.actingAs || '')
    : callServer('getMyEssayAnalytics');
  request.then(function(stats) {
    if (host.isConnected === false) return;
    if (stats && stats.ok) state.essayAnalytics = { key: key, at: Date.now(), stats: stats };
    host.innerHTML = renderEssayStats(stats || {});
    const title = document.getElementById('essay-doc-title');
    if (title && stats && stats.title) title.textContent = stats.title;
  }).catch(function(error) {
    if (host.isConnected === false || isStale(error)) return;
    const message = error && error.message ? error.message : String(error);
    host.innerHTML = '<p class="notice error">' + escapeHtml(message) + '</p>';
  });
}

export function renderEssayStats(stats) {
  if (!stats || !stats.ok) {
    if (stats && stats.reason === 'missing') return '<p class="muted">Not created yet.</p>';
    if (stats && (stats.reason === 'config' || stats.reason === 'auth')) {
      return '<p class="muted">' + escapeHtml(stats.message || 'Word count and edit history are not available yet.') + '</p>';
    }
    return '<p class="notice error">' + escapeHtml((stats && stats.message) || 'The EE Hub could not read this document.') + '</p>';
  }
  const lastEdit = formatLastEdit(stats.lastEdit);
  const streak = stats.streak === null || stats.streak === undefined
    ? '—'
    : (Number(stats.streak) === 1 ? '1 day' : formatCount(stats.streak) + (Number(stats.streak) ? ' days' : ''));
  const streakClass = Number(stats.streak) > 0 ? ' streak' : '';
  const hint = stats.wordsHint ? `<p class="muted doc-hint">${escapeHtml(stats.wordsHint)}</p>` : '';
  const days = stats.days || [];
  const weeks = days.length ? Math.ceil(days.length / 7) : 0;
  const months = (stats.months || []).map(function(month) {
    return `<span style="grid-column:${Number(month.column) + 1}">${escapeHtml(month.label || '')}</span>`;
  }).join('');
  const cells = days.map(function(day) {
    const level = day.future ? '' : ' lvl-' + (Number(day.level) || 0);
    const title = day.future ? '' : (day.date + ': ' + (Number(day.count) ? Number(day.count) + (Number(day.count) === 1 ? ' edit' : ' edits') : 'No edits'));
    return `<i class="heat-cell${day.future ? ' is-future' : ''}${level}"${title ? ` title="${escapeHtml(title)}"` : ''}></i>`;
  }).join('');
  const range = (stats.months || []).map(function(month) { return month.label; }).filter(Boolean);
  const heatmapLabel = 'Edit activity' + (range.length ? ' from ' + range[0] + (range.length > 1 ? ' to ' + range[range.length - 1] : '') : '') + '. Darker green means more edits.';
  const historyNote = stats.revisionsLoaded ? '' : '<p class="muted doc-hint">Edit history is not available for this document yet.</p>';
  return `<div class="doc-stats">
      <div class="doc-stat"><b>${formatCount(stats.wordCount)}</b><span>Current words</span></div>
      <div class="doc-stat" title="Change since about one day ago"><b>${formatWordDelta(stats.wordsDay)}</b><span>Words, last day</span></div>
      <div class="doc-stat" title="Change since about one week ago"><b>${formatWordDelta(stats.wordsWeek)}</b><span>Words, last week</span></div>
      <div class="doc-stat${streakClass}" title="Days in a row with at least one edit"><b>${streak === '0 days' ? '0' : escapeHtml(streak)}</b><span>Edit streak</span></div>
      <div class="doc-stat" title="Google Drive does not report how often a document was opened."><b>${formatCount(stats.opens)}</b><span>Times opened</span></div>
      <div class="doc-stat" title="${escapeHtml(stats.lastEdit ? formatActivityWhen(stats.lastEdit) : '')}"><b class="${lastEdit.length > 12 ? 'compact' : ''}">${escapeHtml(lastEdit)}</b><span>Last edit</span></div>
    </div>
    ${hint}
    <div class="heatmap-head"><strong>Edit activity</strong><div class="heatmap-legend" aria-hidden="true"><span>Less</span><i class="heat-cell"></i><i class="heat-cell lvl-1"></i><i class="heat-cell lvl-2"></i><i class="heat-cell lvl-3"></i><i class="heat-cell lvl-4"></i><span>More</span></div></div>
    ${weeks ? `<div class="heatmap" style="--weeks:${weeks}" role="img" aria-label="${escapeHtml(heatmapLabel)}"><div class="heatmap-months">${months}</div><div class="heatmap-plot"><div class="heatmap-days" aria-hidden="true"><span>M</span><span>W</span><span>F</span></div><div class="heatmap-grid">${cells}</div></div></div>` : ''}
    ${historyNote}`;
}

export function staffStudentBar(home) {
  if (!home || !home.staffView) return '';
  return `<button type="button" class="link-button back" id="staff-back">← My Students</button>
    <p class="muted">${escapeHtml(home.hrm || '')}${home.studentNumber ? ' · ' + escapeHtml(home.studentNumber) : ''}${home.viewLabel ? ' · ' + escapeHtml(home.viewLabel) : ''}</p>`;
}

export function bindStaffStudentChrome() {
  const back = document.getElementById('staff-back');
  if (back) back.addEventListener('click', function() {
    state.staffStudent = null;
    state.staffStudentHome = null;
    state.journeyOpen = false;
    state.notesOpen = false;
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
      state.focusTicket = button.dataset.openUnread;
      state.staffStudent = null;
      state.staffStudentHome = null;
      state.journeyOpen = false;
      state.section = staff ? 'tickets' : 'help';
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
