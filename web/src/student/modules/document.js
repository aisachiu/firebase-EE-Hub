import { callServer } from '../../shared/api.js';
import { escapeHtml, formatCount, formatLastEdit, formatWordDelta, safeUrl } from '../../shared/html.js';
import { isStale } from '../../shared/scene.js';
import { state } from '../../shared/state.js';
import { formatActivityWhen } from '../activity.js';

export const id = 'document';

export function render(home, context) {
  const slot = context && context.slot;
  if (slot && slot !== 'primary') return renderCompact(home);
  return `<h2>${home && home.staffView ? 'Documents' : 'Essay Doc'}</h2>
    <div class="docs-layout">${renderFolderCard(home)}${renderEssayCard(home)}</div>`;
}

export function mount(host, home, context) {
  if (context && context.slot && context.slot !== 'primary') return;
  paintEssayAnalytics(home);
}

function renderCompact(home) {
  const url = safeUrl(home && home.links && home.links.doc);
  return `<h2>Essay Doc</h2><p class="muted">${url ? 'Use Open essay Doc in the header.' : 'Your essay Doc has not been created yet.'}</p>`;
}

export function renderFolderCard(home) {
  const links = (home && home.links) || {};
  const folder = safeUrl(links.folder);
  const extras = [['RPPF', links.rppf], ['Poster', links.poster]].map(function(entry) {
    const url = safeUrl(entry[1]);
    return `<li>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry[0])}</a>` : `<span class="muted">${escapeHtml(entry[0])} not created yet</span>`}</li>`;
  }).join('');
  return `<article class="folder-card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg><h3>Drive folder</h3><p class="muted">${folder ? 'Shared with your supervisor.' : 'Not created yet.'}</p>${folder ? `<a href="${escapeHtml(folder)}" target="_blank" rel="noopener noreferrer">Open folder</a>` : ''}<ul class="folder-links">${extras}</ul></article>`;
}

export function renderEssayCard(home) {
  const url = safeUrl(home && home.links && home.links.doc);
  const empty = `<div class="empty" id="essay-stats"><p>Your essay Doc has not been created yet.</p><p class="muted">When it is ready, Open essay Doc in the header opens the same Google Doc from Document, Journey, and Supervisor.</p></div>`;
  return `<article class="doc-dashboard"><div class="doc-head"><h3><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg><span id="essay-doc-title">Extended Essay</span></h3>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in Google Docs</a>` : ''}</div>${url ? '<div id="essay-stats"><p class="muted">Reading the Google Doc…</p></div>' : empty}</article>`;
}

export function essayAnalyticsKey(home) {
  return ((home && home.email) || '') + '|' + ((home && home.links && home.links.doc) || '');
}

export function paintEssayAnalytics(home) {
  const host = document.getElementById('essay-stats');
  if (!host) return;
  const url = safeUrl(home && home.links && home.links.doc);
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
    if (stats && stats.reason === 'missing') {
      return '<div class="empty"><p>Your essay Doc has not been created yet.</p></div>';
    }
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
