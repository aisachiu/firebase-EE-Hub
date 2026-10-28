import { escapeHtml, formatActivityWhen } from '../../shared/html.js';
import { milestoneTitleText, systemItemFor } from '../home.js';

export const id = 'meetingNotes';

export function render(home, context) {
  const meetings = ((home && home.templates) || []).filter(function(template) { return template.type === 'meeting'; });
  const notes = (home && home.sessionNotes) || [];
  const compact = context && context.slot === 'compact';
  if (!meetings.length && !notes.length) {
    return `<h2>Meeting notes</h2><div class="empty"><p>Session notes appear here after your supervisor logs a meeting.</p></div>`;
  }
  const noteByMilestone = {};
  notes.forEach(function(note) {
    const key = note.milestoneId || '';
    if (!noteByMilestone[key]) noteByMilestone[key] = [];
    noteByMilestone[key].push(note);
  });
  const rows = meetings.map(function(template) {
    const item = systemItemFor(home, template.milestoneId);
    const title = milestoneTitleText(template, item);
    const due = item && item.DueDate ? String(item.DueDate).slice(0, 10) : '';
    const status = item && item.Status === 'Completed' ? 'Logged' : 'Not logged yet';
    const logged = noteByMilestone[template.milestoneId] || [];
    const body = compact ? '' : logged.map(renderNote).join('') || '<p class="muted">No note yet.</p>';
    return `<article class="meeting-note"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(status)}${due ? ' · ' + escapeHtml(due) : ''}</p>${body}</article>`;
  }).join('');
  const orphans = notes.filter(function(note) {
    return !meetings.some(function(template) { return template.milestoneId === note.milestoneId; });
  });
  const extra = compact ? '' : orphans.map(renderNote).join('');
  const count = notes.length ? `<p class="muted">${notes.length} session ${notes.length === 1 ? 'note' : 'notes'}</p>` : '';
  return `<h2>Meeting notes</h2>${count}${rows}${extra}`;
}

export function mount() {}

function renderNote(note) {
  const when = note.at ? formatActivityWhen(note.at) : '';
  return `<blockquote class="session-note"><p>${escapeHtml(note.comment || '')}</p>${when ? `<p class="muted">${escapeHtml(when)}</p>` : ''}</blockquote>`;
}
