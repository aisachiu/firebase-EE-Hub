import { callServer } from '../shared/api.js';
import { escapeHtml, formatActivityWhen } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { state } from '../shared/state.js';

export { formatActivityWhen };

export function paintStudentActivity(home) {
  const host = document.getElementById('my-activity');
  const copy = home.staffView ? {
    heading: 'Activity',
    lede: 'Actions ' + (home.displayName || 'this student') + ' took in the EE Hub, plus email reminders sent to them.',
    empty: 'Nothing here yet. Actions this student takes, and email reminders sent to them, will show up in this list.'
  } : {
    heading: 'Your activity',
    lede: 'Actions you took in the EE Hub, plus email reminders sent to you.',
    empty: 'Nothing here yet. Signing in, forms, to-dos, messages, and email reminders sent to you will show up in this list.'
  };
  const cached = state.activityFeed;
  if (cached && cached.email === home.email) {
    if (!host) return;
    host.innerHTML = renderActivityDashboard(cached.feed || {}, copy);
    bindActivityDashboard(host);
    return;
  }
  const request = home.staffView
    ? callServer('getStudentActivity', home.email, home.cohort || '')
    : callServer('getMyActivity');
  loadActivityDashboard(host, request.then(function(feed) {
    state.activityFeed = { email: home.email, feed: feed || {} };
    return feed;
  }), copy);
}

export var ACTIVITY_PAGE_SIZE = 16;

export var ACTIVITY_KINDS = [
  ['all', 'All'],
  ['sign-in', 'Sign-ins'],
  ['form', 'Forms'],
  ['task', 'Tasks'],
  ['question', 'Messages'],
  ['email', 'Emails'],
  ['other', 'Other']
];

export function loadActivityDashboard(host, request, options) {
  if (!host) return;
  const copy = options || {};
  host.innerHTML = loadingLine('Loading activity...');
  request.then(function(feed) {
    if (!host.isConnected) return;
    host.innerHTML = renderActivityDashboard(feed || {}, copy);
    bindActivityDashboard(host);
  }).catch(function(error) {
    if (!host.isConnected) return;
    host.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
  });
}

export function renderActivityDashboard(feed, options) {
  const entries = feed.entries || [];
  const span = activitySpan(entries);
  const filters = ACTIVITY_KINDS.filter(function(kind) {
    if (kind[0] === 'all') return entries.length;
    return entries.some(function(entry) { return entry.kind === kind[0]; });
  }).map(function(kind) {
    const count = kind[0] === 'all' ? entries.length : entries.filter(function(entry) { return entry.kind === kind[0]; }).length;
    return `<button type="button" data-activity-kind="${kind[0]}" aria-pressed="${kind[0] === 'all' ? 'true' : 'false'}">${kind[1]} <span data-kind-count>${count}</span></button>`;
  }).join('');
  const list = entries.map(function(entry) {
    const day = activityDayNumber(activityDayKey(entry.at));
    const offset = span && !isNaN(day) ? String(day - span.min) : '';
    const details = entry.details && entry.details.length
      ? entry.details.map(function(detail) {
        return `<div><dt>${escapeHtml(detail.label)}</dt><dd>${escapeHtml(detail.value)}</dd></div>`;
      }).join('')
      : '<div><dt>Detail</dt><dd>No extra detail was recorded for this action.</dd></div>';
    return `<article class="activity-item ${escapeHtml(entry.outcome || 'done')}" data-activity-item data-kind="${escapeHtml(entry.kind || 'other')}" data-day="${offset}">
      <button type="button" class="activity-toggle" aria-expanded="false">
        <time class="activity-when" datetime="${escapeHtml(entry.at || '')}">${escapeHtml(formatActivityWhen(entry.at))}</time>
        <span class="activity-line"><strong>${escapeHtml(entry.title || 'Activity')}</strong> <small>${escapeHtml(entry.summary || '')}</small></span>
        <span class="activity-mark">${escapeHtml(activityOutcomeLabel(entry.outcome))}</span>
      </button>
      <dl class="activity-detail hidden">${details}</dl>
    </article>`;
  }).join('');
  const slider = span ? `<div class="activity-slider">
      <div class="activity-slider-labels"><span data-range-start></span><span data-range-end></span></div>
      <div class="activity-slider-control" data-slider-control>
        <div class="activity-slider-rail"></div>
        <div class="activity-slider-fill" data-range-fill></div>
        <button type="button" class="activity-slider-thumb" data-range-thumb="start" role="slider" aria-label="From date" aria-valuemin="0" aria-valuemax="${span.span}" aria-valuenow="0"></button>
        <button type="button" class="activity-slider-thumb" data-range-thumb="end" role="slider" aria-label="To date" aria-valuemin="0" aria-valuemax="${span.span}" aria-valuenow="${span.span}"></button>
      </div>
    </div>` : '';
  const truncated = feed.truncated ? `<p class="muted">Showing the latest ${entries.length} of ${feed.total}.</p>` : '';
  return `<section class="activity-panel" data-range-origin="${span ? span.min : ''}" data-range-span="${span ? span.span : ''}">
    <p class="eyebrow">Activity</p>
    <h2>${escapeHtml(options.heading || 'Activity')}</h2>
    <p class="lede">${escapeHtml(options.lede || 'Actions this student took in the EE Hub.')}</p>
    ${truncated}
    ${entries.length ? `${slider}
      <div class="activity-filters" role="group" aria-label="Filter activity">${filters}</div>
      <div class="activity-list">${list}</div>
      <div class="empty hidden" data-activity-filter-empty>Nothing in this view.</div>
      <button type="button" class="button secondary activity-more" data-activity-more>Show earlier activity</button>` : `<div class="empty">${escapeHtml(options.empty || 'Nothing here yet.')}</div>`}
  </section>`;
}

export function bindActivityDashboard(host) {
  const panel = host.querySelector('.activity-panel') || host;
  host.dataset.activityKind = 'all';
  host.dataset.activityShown = String(ACTIVITY_PAGE_SIZE);
  host.dataset.rangeOrigin = panel.dataset.rangeOrigin || '';
  host.dataset.rangeSpan = panel.dataset.rangeSpan || '0';
  host.dataset.rangeStart = '0';
  host.dataset.rangeEnd = panel.dataset.rangeSpan || '0';
  host.querySelectorAll('[data-activity-kind]').forEach(function(button) {
    button.addEventListener('click', function() {
      if (button.disabled) return;
      host.dataset.activityKind = button.dataset.activityKind;
      host.dataset.activityShown = String(ACTIVITY_PAGE_SIZE);
      host.querySelectorAll('[data-activity-kind]').forEach(function(other) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
      applyActivityView(host);
    });
  });
  host.querySelectorAll('.activity-toggle').forEach(function(button) {
    button.addEventListener('click', function() {
      const detail = button.parentElement.querySelector('.activity-detail');
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (detail) detail.classList.toggle('hidden', open);
    });
  });
  const more = host.querySelector('[data-activity-more]');
  if (more) more.addEventListener('click', function() {
    host.dataset.activityShown = String(Number(host.dataset.activityShown || ACTIVITY_PAGE_SIZE) + ACTIVITY_PAGE_SIZE);
    applyActivityView(host);
  });
  bindActivitySlider(host);
  applyActivityView(host);
}

export function bindActivitySlider(host) {
  const control = host.querySelector('[data-slider-control]');
  if (!control) return;
  const span = Number(host.dataset.rangeSpan || 0);
  function moveThumb(which, next) {
    const start = Number(host.dataset.rangeStart || 0);
    const end = Number(host.dataset.rangeEnd || 0);
    const value = Math.max(0, Math.min(span, next));
    if (which === 'start') {
      host.dataset.rangeStart = String(Math.min(value, end));
    } else {
      host.dataset.rangeEnd = String(Math.max(value, start));
    }
    paintActivitySlider(host);
    applyActivityView(host);
  }
  function valueFromPointer(event) {
    const rect = control.getBoundingClientRect();
    if (!rect.width) return 0;
    const ratio = (event.clientX - rect.left) / rect.width;
    return Math.round(Math.max(0, Math.min(1, ratio)) * span);
  }
  control.addEventListener('pointerdown', function(event) {
    if (span === 0) return;
    const thumb = event.target.closest('[data-range-thumb]');
    const next = valueFromPointer(event);
    const start = Number(host.dataset.rangeStart || 0);
    const end = Number(host.dataset.rangeEnd || 0);
    const which = thumb ? thumb.dataset.rangeThumb : (next <= (start + end) / 2 ? 'start' : 'end');
    host.dataset.rangeDrag = which;
    control.setPointerCapture(event.pointerId);
    moveThumb(which, next);
  });
  control.addEventListener('pointermove', function(event) {
    if (!host.dataset.rangeDrag) return;
    moveThumb(host.dataset.rangeDrag, valueFromPointer(event));
  });
  function endDrag() { delete host.dataset.rangeDrag; }
  control.addEventListener('pointerup', endDrag);
  control.addEventListener('pointercancel', endDrag);
  host.querySelectorAll('[data-range-thumb]').forEach(function(thumb) {
    thumb.addEventListener('keydown', function(event) {
      const which = thumb.dataset.rangeThumb;
      const current = Number(which === 'start' ? host.dataset.rangeStart : host.dataset.rangeEnd);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') moveThumb(which, current - 1);
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') moveThumb(which, current + 1);
      else if (event.key === 'Home') moveThumb(which, 0);
      else if (event.key === 'End') moveThumb(which, span);
      else return;
      event.preventDefault();
    });
  });
  paintActivitySlider(host);
}

export function paintActivitySlider(host) {
  const span = Number(host.dataset.rangeSpan || 0);
  const start = Number(host.dataset.rangeStart || 0);
  const end = Number(host.dataset.rangeEnd || span);
  const startPct = span === 0 ? 0 : (start / span) * 100;
  const endPct = span === 0 ? 0 : (end / span) * 100;
  const fill = host.querySelector('[data-range-fill]');
  const startThumb = host.querySelector('[data-range-thumb="start"]');
  const endThumb = host.querySelector('[data-range-thumb="end"]');
  const startLabel = host.querySelector('[data-range-start]');
  const endLabel = host.querySelector('[data-range-end]');
  if (fill) {
    fill.style.left = startPct + '%';
    fill.style.width = Math.max(0, endPct - startPct) + '%';
  }
  const startText = activityDateFromOffset(host, start);
  const endText = activityDateFromOffset(host, end);
  const meetAtEnd = start === end && span > 0 && start === span;
  if (startThumb) {
    startThumb.style.left = startPct + '%';
    startThumb.style.zIndex = meetAtEnd ? '2' : '1';
    startThumb.setAttribute('aria-valuenow', String(start));
    startThumb.setAttribute('aria-valuetext', startText);
  }
  if (endThumb) {
    endThumb.style.left = endPct + '%';
    endThumb.style.zIndex = meetAtEnd ? '1' : '2';
    endThumb.setAttribute('aria-valuenow', String(end));
    endThumb.setAttribute('aria-valuetext', endText);
  }
  if (startLabel) startLabel.textContent = startText;
  if (endLabel) endLabel.textContent = endText;
}

export function applyActivityView(host) {
  const kind = host.dataset.activityKind || 'all';
  const shown = Number(host.dataset.activityShown || ACTIVITY_PAGE_SIZE);
  const start = Number(host.dataset.rangeStart || 0);
  const end = Number(host.dataset.rangeEnd || 0);
  const counts = { all: 0 };
  let matches = 0;
  host.querySelectorAll('[data-activity-item]').forEach(function(item) {
    const day = item.dataset.day;
    const inRange = day === '' || (Number(day) >= start && Number(day) <= end);
    if (!inRange) {
      item.classList.add('hidden');
      return;
    }
    counts.all += 1;
    counts[item.dataset.kind] = (counts[item.dataset.kind] || 0) + 1;
    const include = kind === 'all' || item.dataset.kind === kind;
    if (!include) {
      item.classList.add('hidden');
      return;
    }
    item.classList.toggle('hidden', matches >= shown);
    matches += 1;
  });
  host.querySelectorAll('[data-activity-kind]').forEach(function(button) {
    const count = counts[button.dataset.activityKind] || 0;
    const badge = button.querySelector('[data-kind-count]');
    if (badge) badge.textContent = String(count);
    button.disabled = button.dataset.activityKind !== 'all' && button.getAttribute('aria-pressed') !== 'true' && count === 0;
  });
  const more = host.querySelector('[data-activity-more]');
  if (more) {
    const left = matches - shown;
    more.classList.toggle('hidden', left <= 0);
    more.textContent = left > 0 ? 'Show earlier activity (' + left + ')' : 'Show earlier activity';
  }
  const empty = host.querySelector('[data-activity-filter-empty]');
  if (empty) empty.classList.toggle('hidden', matches !== 0);
}

export function activityDayKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? match[1] + '-' + match[2] + '-' + match[3] : '';
}

export function activityDayNumber(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
}

export function activitySpan(entries) {
  let min = Infinity;
  let max = -Infinity;
  entries.forEach(function(entry) {
    const day = activityDayNumber(activityDayKey(entry.at));
    if (isNaN(day)) return;
    if (day < min) min = day;
    if (day > max) max = day;
  });
  if (!isFinite(min)) return null;
  return { min: min, max: max, span: max - min };
}

export function activityDateFromOffset(host, offset) {
  const origin = Number(host.dataset.rangeOrigin);
  if (!isFinite(origin)) return '';
  const date = new Date((origin + Number(offset)) * 86400000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return date.getUTCDate() + ' ' + months[date.getUTCMonth()] + ' ' + date.getUTCFullYear();
}

export function activityOutcomeLabel(outcome) {
  if (outcome === 'failed') return 'Not saved';
  if (outcome === 'started') return 'Started';
  if (outcome === 'info') return 'Recorded';
  return 'Saved';
}
