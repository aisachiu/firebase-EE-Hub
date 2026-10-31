import { escapeHtml } from '../../shared/html.js';
import {
  initialMonthWindow,
  milestoneMarks,
  monthIndexFromDate,
  monthTitle,
  splitMonthIndex,
} from '../rotary.js';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function formatDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

export function renderMonthHtml(index, marks, todayKey) {
  const parts = splitMonthIndex(index);
  const year = parts.year;
  const month = parts.month;
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  let cells = '';
  for (let blank = 0; blank < firstDow; blank += 1) cells += '<div class="ee-day is-out"></div>';
  for (let day = 1; day <= days; day += 1) {
    const date = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const items = (marks || []).filter(function(mark) { return mark.date === date; });
    const chips = items.map(function(mark) {
      return `<span class="ee-ms is-${escapeHtml(mark.status)}" title="${escapeHtml(mark.title)}">${escapeHtml(mark.title)}</span>`;
    }).join('');
    const classes = ['ee-day'];
    if (date === todayKey) classes.push('is-today');
    if (items.some(function(mark) { return mark.status === 'current'; })) classes.push('is-next');
    cells += `<div class="${classes.join(' ')}" data-date="${date}"><span class="ee-day-num">${day}</span>${chips}</div>`;
  }
  const heads = WEEKDAYS.map(function(label) { return '<span>' + label + '</span>'; }).join('');
  return `<section class="ee-month" data-month="${year}-${String(month + 1).padStart(2, '0')}"><h3>${escapeHtml(monthTitle(index))}</h3><div class="ee-weekdays" aria-hidden="true">${heads}</div><div class="ee-month-grid">${cells}</div></section>`;
}

export function monthsHtml(start, end, marks, todayKey) {
  let html = '';
  for (let index = start; index <= end; index += 1) html += renderMonthHtml(index, marks, todayKey);
  return html;
}

/** Vertical month stack. No range picker and no Earlier/Later controls. */
export function calendarShellHtml() {
  return `<div class="ee-cal-head"><div><div class="ee-cal-name">Calendar</div><p class="muted">Official milestone due dates</p></div><button type="button" class="button secondary" data-cal-next>Next milestone</button></div><p class="muted ee-cal-hint">Scroll for more months</p><div class="ee-cal-scroll" data-cal-scroll><div data-cal-track></div></div>`;
}

export function mountCalendar(host, home) {
  if (!host) return;
  const marks = milestoneMarks(home);
  const todayKey = formatDay(new Date());
  const span = initialMonthWindow(marks, new Date());
  let start = span.start;
  let end = span.end;
  let loading = false;
  host.innerHTML = calendarShellHtml();
  const scroll = host.querySelector('[data-cal-scroll]');
  const track = host.querySelector('[data-cal-track]');
  if (!scroll || !track) return;
  track.innerHTML = monthsHtml(start, end, marks, todayKey);

  function prepend(count) {
    const before = track.scrollHeight;
    const from = start - count;
    track.insertAdjacentHTML('afterbegin', monthsHtml(from, start - 1, marks, todayKey));
    start = from;
    scroll.scrollTop += track.scrollHeight - before;
  }

  function append(count) {
    track.insertAdjacentHTML('beforeend', monthsHtml(end + 1, end + count, marks, todayKey));
    end += count;
  }

  function cover(date) {
    const index = monthIndexFromDate(date);
    if (!isFinite(index)) return;
    if (index < start) prepend(start - index);
    if (index > end) append(index - end);
  }

  const release = window.requestAnimationFrame || function(fn) { return setTimeout(fn, 0); };
  scroll.addEventListener('scroll', function() {
    if (loading || !scroll.clientHeight) return;
    if (scroll.scrollTop < 72) {
      loading = true;
      prepend(3);
      release(function() { loading = false; });
      return;
    }
    if (scroll.scrollTop + scroll.clientHeight > scroll.scrollHeight - 72) {
      loading = true;
      append(3);
      release(function() { loading = false; });
    }
  });

  const next = host.querySelector('[data-cal-next]');
  if (next) next.addEventListener('click', function() {
    const current = marks.filter(function(mark) { return mark.status === 'current'; })[0];
    const date = current ? current.date : todayKey;
    cover(date);
    const cell = host.querySelector('[data-date="' + date + '"]');
    if (cell && cell.scrollIntoView) cell.scrollIntoView({ block: 'center' });
  });
}
