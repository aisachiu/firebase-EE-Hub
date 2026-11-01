import { callServer, markSync } from '../../shared/api.js';
import { showError } from '../../shared/feedback.js';
import { escapeHtml, formatActivityWhen, safeUrl } from '../../shared/html.js';
import { isStale } from '../../shared/scene.js';
import { milestoneTitleText, systemItemFor } from '../home.js';

export const id = 'meetingNotes';

const saveTimers = new WeakMap();

export function noteMetrics(value) {
  const body = String(value || '');
  const trimmed = body.trim();
  return {
    characters: body.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
  };
}

export function reflectionDocHref(value) {
  const href = safeUrl(value);
  if (!href) return '';
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== 'docs.google.com') return '';
    if (!/^\/document\/d\/[^/]+/.test(parsed.pathname)) return '';
    return parsed.href;
  } catch (error) {
    return '';
  }
}

export function render(home, context) {
  const compact = context && context.slot === 'compact';
  const logged = renderLogged(home, compact);
  const reflections = compact ? '' : renderReflections(home, !!(home && home.staffView));
  return `<h2>Meeting notes</h2>${logged}${reflections}`;
}

export function mount(host, home) {
  if (!host || !home || home.staffView) return;
  host.querySelectorAll('[data-reflection-note]').forEach(function(article) {
    bindReflection(article, home);
  });
}

function renderLogged(home, compact) {
  const meetings = ((home && home.templates) || []).filter(function(template) { return template.type === 'meeting'; });
  const notes = (home && home.sessionNotes) || [];
  if (!meetings.length && !notes.length) {
    return '<div class="empty"><p>Session notes appear here after your supervisor logs a meeting.</p></div>';
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
  return `${count}${rows}${extra}`;
}

function renderReflections(home, locked) {
  const notes = reflectionNotes(home);
  const rows = notes.map(function(note) { return renderReflection(note, locked); }).join('');
  return `<div class="reflection-notes"><h2>Your reflections</h2><p class="muted">${locked ? 'The student writes these notes.' : 'Write a short note for each meeting. Counts update as you type.'}</p>${rows}</div>`;
}

function reflectionNotes(home) {
  const notes = home && home.reflectionNotes;
  if (notes && notes.length) return notes;
  return [{ noteId: 'viva-voce', title: 'Viva Voce', body: '', complete: false, date: '', docLink: '' }];
}

function renderReflection(note, locked) {
  const metrics = noteMetrics(note.body || '');
  const href = reflectionDocHref(note.docLink);
  const disabled = locked ? ' disabled' : '';
  const readOnly = locked ? ' readonly' : '';
  const link = href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open extended notes</a>`
    : '';
  return `<article class="reflection-note" data-reflection-note="${escapeHtml(note.noteId)}">
    <h3>${escapeHtml(note.title || 'Note')}</h3>
    <textarea data-reflection-body aria-label="${escapeHtml(note.title || 'Note')}" maxlength="8000"${readOnly}>${escapeHtml(note.body || '')}</textarea>
    <p class="reflection-metrics" data-reflection-metrics><span data-reflection-chars>${metrics.characters}</span> characters · <span data-reflection-words>${metrics.words}</span> words</p>
    <div class="reflection-meta">
      <label class="check-option"><input type="checkbox" data-reflection-complete${note.complete ? ' checked' : ''}${disabled}> Complete</label>
      <label>Date <input type="date" data-reflection-date value="${escapeHtml(note.date || '')}"${disabled}></label>
    </div>
    <label class="reflection-link-label">Google Doc<input type="url" data-reflection-link placeholder="https://docs.google.com/document/..." value="${escapeHtml(note.docLink || '')}"${disabled}></label>
    <p class="reflection-doc" data-reflection-doc>${link}</p>
    <p class="reflection-link-error muted" data-reflection-link-error hidden></p>
  </article>`;
}

function bindReflection(article, home) {
  const body = article.querySelector('[data-reflection-body]');
  const complete = article.querySelector('[data-reflection-complete]');
  const date = article.querySelector('[data-reflection-date]');
  const link = article.querySelector('[data-reflection-link]');
  if (!body || !complete || !date || !link) return;
  function paintMetrics() {
    const metrics = noteMetrics(body.value);
    const chars = article.querySelector('[data-reflection-chars]');
    const words = article.querySelector('[data-reflection-words]');
    if (chars) chars.textContent = String(metrics.characters);
    if (words) words.textContent = String(metrics.words);
    syncLocal(home, article.getAttribute('data-reflection-note'), {
      body: body.value,
      complete: complete.checked,
      date: date.value,
    });
  }
  function paintLink() {
    const href = reflectionDocHref(link.value);
    const slot = article.querySelector('[data-reflection-doc]');
    const error = article.querySelector('[data-reflection-link-error]');
    const raw = link.value.trim();
    if (slot) {
      slot.innerHTML = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open extended notes</a>` : '';
    }
    if (error) {
      const bad = raw && !href;
      error.hidden = !bad;
      error.textContent = bad ? 'Paste a Google Doc link.' : '';
    }
  }
  body.addEventListener('input', function() {
    paintMetrics();
    schedule(article, home, false);
  });
  link.addEventListener('input', function() {
    paintLink();
    schedule(article, home, false);
  });
  complete.addEventListener('change', function() {
    paintMetrics();
    schedule(article, home, true);
  });
  date.addEventListener('change', function() {
    paintMetrics();
    schedule(article, home, true);
  });
  body.addEventListener('blur', function() { schedule(article, home, true); });
  link.addEventListener('blur', function() { schedule(article, home, true); });
}

function schedule(article, home, immediate) {
  const existing = saveTimers.get(article);
  if (existing) window.clearTimeout(existing);
  const run = function() {
    saveTimers.delete(article);
    commit(article, home);
  };
  if (immediate) run();
  else saveTimers.set(article, window.setTimeout(run, 400));
}

function commit(article, home) {
  const noteId = article.getAttribute('data-reflection-note');
  const body = article.querySelector('[data-reflection-body]');
  const complete = article.querySelector('[data-reflection-complete]');
  const date = article.querySelector('[data-reflection-date]');
  const link = article.querySelector('[data-reflection-link]');
  if (!noteId || !body || !complete || !date || !link) return;
  const rawLink = link.value.trim();
  const href = reflectionDocHref(rawLink);
  if (rawLink && !href) return;
  const payload = {
    body: body.value,
    complete: complete.checked,
    date: date.value,
    docLink: href,
  };
  syncLocal(home, noteId, payload);
  markSync(article, 'pending');
  callServer('saveReflectionNote', noteId, payload).then(function(saved) {
    if (!article.isConnected) return;
    syncLocal(home, noteId, saved || payload);
    markSync(article, 'confirmed');
  }).catch(function(error) {
    if (isStale(error) || !article.isConnected) return;
    markSync(article, 'rejected');
    showError(error, article);
  });
}

function syncLocal(home, noteId, patch) {
  if (!home || !noteId || !patch) return;
  if (!home.reflectionNotes) home.reflectionNotes = reflectionNotes(home).slice();
  let note = home.reflectionNotes.filter(function(item) { return item && item.noteId === noteId; })[0];
  if (!note) {
    note = { noteId: noteId, title: noteId };
    home.reflectionNotes.push(note);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'body')) note.body = patch.body;
  if (Object.prototype.hasOwnProperty.call(patch, 'complete')) note.complete = !!patch.complete;
  if (Object.prototype.hasOwnProperty.call(patch, 'date')) note.date = patch.date || '';
  if (Object.prototype.hasOwnProperty.call(patch, 'docLink')) note.docLink = patch.docLink || '';
}

function renderNote(note) {
  const when = note.at ? formatActivityWhen(note.at) : '';
  return `<blockquote class="session-note"><p>${escapeHtml(note.comment || '')}</p>${when ? `<p class="muted">${escapeHtml(when)}</p>` : ''}</blockquote>`;
}
