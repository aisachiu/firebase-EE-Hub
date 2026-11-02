import { clampEePage, stepEePage } from '../shared/eePage.js';
import { escapeHtml } from '../shared/html.js';

export { clampEePage, stepEePage };

export const EE_MOBILE_MAX = 700;

export const EE_PAGES = [
  { id: 0, key: 'document', title: 'Document', mobileTitle: 'Document' },
  { id: 1, key: 'journey', title: 'Journey', mobileTitle: 'Journey' },
  { id: 2, key: 'calendar', title: 'Calendar', mobileTitle: 'Calendar' },
  { id: 3, key: 'supervisor', title: 'Meetings', mobileTitle: 'Meetings' },
  { id: 4, key: 'chat', title: 'Supervisor Chat', mobileTitle: 'Chat' },
];

export const STUDENT_PAGE_TOGGLES = [
  { key: 'document', label: 'Document', hint: 'Document' },
  { key: 'journey', label: 'Journey', hint: 'Journey' },
  { key: 'calendar', label: 'Calendar', hint: 'Calendar' },
  { key: 'supervisor', label: 'Supervisor', hint: 'Shown as Meetings' },
  { key: 'chat', label: 'Chat', hint: 'Shown as Supervisor Chat' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function pageTitle(page, mobile) {
  const row = EE_PAGES[clampEePage(page)];
  return mobile ? row.mobileTitle : row.title;
}

/** Legacy preview names still open the matching page. */
export function previewPage(value) {
  if (value === 'journey') return 1;
  if (value === 'supervisor' || value === 'help') return 3;
  if (value === 'chat') return 4;
  if (value === 'calendar') return 2;
  return clampEePage(value);
}

/** Existing ledger names. A page can open more than one view. */
export function studentViewsForPage(page) {
  const views = {
    0: ['document'],
    1: ['document', 'journey'],
    2: ['journey'],
    3: ['supervisor'],
    4: ['document', 'supervisor'],
  };
  return views[clampEePage(page)].slice();
}

function explicitPages(pages) {
  return Array.isArray(pages) ? pages : EE_PAGES;
}

/** Hidden admin flags drop that page from the carousel. A missing flag stays visible. */
export function visibleEePages(flags) {
  const source = flags || {};
  return EE_PAGES.filter(function(row) {
    if (!row.key || !Object.prototype.hasOwnProperty.call(source, row.key)) return true;
    return source[row.key] !== false;
  });
}

export function settleVisiblePage(page, pages) {
  const list = explicitPages(pages);
  if (!list.length) return 0;
  const ids = list.map(function(row) { return row.id; });
  const index = clampEePage(page);
  if (ids.indexOf(index) >= 0) return index;
  return ids[0];
}

export function stepVisiblePage(page, direction, pages) {
  const list = explicitPages(pages);
  const ids = list.map(function(row) { return row.id; });
  if (!ids.length) return 0;
  const current = ids.indexOf(clampEePage(page));
  const start = current < 0 ? 0 : current;
  const delta = direction < 0 ? -1 : 1;
  return ids[(start + delta + ids.length) % ids.length];
}

/** Signed slot distance that keeps the active title in the center of a loop. */
export function circularOffset(index, active, count) {
  const total = Number(count) || 0;
  if (total <= 1) return 0;
  let delta = index - active;
  const half = total / 2;
  if (delta > half) delta -= total;
  if (delta < -half) delta += total;
  return delta;
}

export function titleCarouselHtml(page, pages) {
  const list = explicitPages(pages);
  const active = settleVisiblePage(page, list);
  const titles = list.map(function(row) {
    const on = row.id === active;
    return `<button type="button" class="ee-carousel-title${on ? ' is-active' : ''}" data-open-ee-page="${row.id}" aria-current="${on ? 'page' : 'false'}">${escapeHtml(row.title)}</button>`;
  }).join('');
  const locked = list.length < 2 ? ' disabled' : '';
  return `<nav class="ee-carousel" data-ee-carousel aria-label="EE pages"><button type="button" class="ee-carousel-arrow" data-ee-prev aria-label="Previous page"${locked}>‹</button><div class="ee-carousel-window" data-ee-carousel-window>${titles}</div><button type="button" class="ee-carousel-arrow" data-ee-next aria-label="Next page"${locked}>›</button></nav>`;
}

/**
 * Strip offset in stage-widths. Negative moves content left.
 * `strip` order is document | journey | calendar | meetings | chat.
 * `alt` order is meetings | chat | document | … used only while 3 and 4 trade places.
 * Settled page 4 is a separate order (chat | document) at offset 0, so this returns 0 for page 4 in strip mode.
 */
export function stripOffset(page, mode) {
  const index = clampEePage(page);
  if (mode === 'alt') return index === 4 ? -2 / 3 : 0;
  if (index === 2) return -2 / 3;
  if (index === 3) return -5 / 3;
  return 0;
}

export function stripOffsetPx(page, stageWidth, mode) {
  return stripOffset(page, mode) * Number(stageWidth || 0);
}

export function dateParts(iso) {
  const text = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const bits = text.split('-');
  const year = Number(bits[0]);
  const month = Number(bits[1]);
  const day = Number(bits[2]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return {
    year: year,
    month: month,
    day: day,
    label: MONTHS[month - 1],
    weekday: WEEKDAYS[utc.getUTCDay()],
  };
}

export function monthIndex(year, month) {
  return year * 12 + month;
}

export function splitMonthIndex(index) {
  const year = Math.floor(index / 12);
  return { year: year, month: index - year * 12 };
}

export function monthIndexFromDate(iso) {
  const parts = dateParts(iso);
  if (!parts) return NaN;
  return monthIndex(parts.year, parts.month - 1);
}

/** Official milestone due dates only. Status comes from the same next-incomplete walk as the journey. */
export function milestoneMarks(home) {
  const templates = (home && home.templates) || [];
  const items = (home && home.actionItems) || [];
  const phases = (home && home.phases) || [];
  const byTemplate = {};
  items.forEach(function(item) {
    if (item && item.CreatorType === 'System' && item.TemplateId) byTemplate[item.TemplateId] = item;
  });
  let nextId = '';
  for (let index = 0; index < templates.length; index += 1) {
    const item = byTemplate[templates[index].milestoneId];
    if (!item || item.Status !== 'Completed') {
      nextId = templates[index].milestoneId;
      break;
    }
  }
  const marks = [];
  templates.forEach(function(template) {
    const item = byTemplate[template.milestoneId] || null;
    const due = item && item.DueDate ? String(item.DueDate).slice(0, 10) : '';
    if (!dateParts(due)) return;
    const phaseId = (item && item.PhaseId) || template.phase || '';
    const phaseIndex = phases.findIndex(function(phase) { return phase && phase.phaseId === phaseId; });
    const done = !!(item && item.Status === 'Completed');
    marks.push({
      id: template.milestoneId,
      date: due,
      title: (item && item.Title) || template.title || template.milestoneId || 'Milestone',
      phase: phaseIndex >= 0 ? phaseIndex + 1 : 0,
      status: done ? 'done' : (template.milestoneId === nextId ? 'current' : 'upcoming'),
    });
  });
  return marks;
}

export function initialMonthWindow(marks, today) {
  const base = monthIndex(today.getFullYear(), today.getMonth());
  let start = base;
  let end = base;
  (marks || []).forEach(function(mark) {
    const index = monthIndexFromDate(mark && mark.date);
    if (!isFinite(index)) return;
    if (index < start) start = index;
    if (index > end) end = index;
  });
  start -= 1;
  end += 1;
  if (end - start < 3) end = start + 3;
  return { start: start, end: end };
}

export function monthTitle(index) {
  const parts = splitMonthIndex(index);
  return MONTHS[parts.month] + ' ' + parts.year;
}

/** Embedded editor. School policies that block iframes are handled by the fallback link. */
export function essayEmbedSrc(url) {
  const value = String(url || '').trim();
  if (!/^https:\/\/docs\.google\.com\/document\//.test(value)) return '';
  const match = /\/document\/d\/([^/?#]+)/.exec(value);
  if (!match) return '';
  return 'https://docs.google.com/document/d/' + match[1] + '/edit?embedded=true';
}

export function isDocComment(entry) {
  if (!entry) return false;
  if (entry.kind === 'doc-comment' || entry.type === 'doc-comment') return true;
  if (entry.quote || entry.commentId || entry.disco) return true;
  return /doc(ument)? comment/i.test(String(entry.category || ''));
}

/** Desktop meetings and chat show the chat column. On a phone only the chat page does. */
export function chatPaneOpen(page, mobile) {
  const index = clampEePage(page);
  if (mobile) return index === 4;
  return index === 3 || index === 4;
}

/** Live Docs comment links use disco=. A full URL is kept as given. */
export function docCommentHref(docUrl, commentId) {
  const id = String(commentId || '').trim();
  if (/^https:\/\/docs\.google\.com\//.test(id)) return id;
  const base = String(docUrl || '').trim();
  if (!/^https:\/\/docs\.google\.com\//.test(base)) return '';
  if (!id) return base;
  const join = base.indexOf('?') >= 0 ? '&' : '?';
  if (/^disco=/i.test(id)) return base + join + id;
  return base + join + 'disco=' + encodeURIComponent(id);
}

function threadAuthor(message, staff, viewer, home) {
  const fromStudent = message.authorRole === 'student';
  const email = String(message.authorEmail || '').trim().toLowerCase();
  if (!staff) {
    return {
      mine: fromStudent,
      author: fromStudent ? 'You' : (message.authorName || 'Supervisor'),
    };
  }
  if (viewer && email === viewer) return { mine: true, author: 'You' };
  if (fromStudent) return { mine: false, author: message.authorName || (home && home.displayName) || 'Student' };
  return { mine: false, author: message.authorName || 'Supervisor' };
}

function docThreadItem(source, docUrl, at, author) {
  const commentId = source.commentId || source.threadId || source.disco || '';
  return {
    type: 'doc',
    at: at,
    author: author,
    quote: source.quote || '',
    body: source.body || source.text || '',
    href: docCommentHref(source.docUrl || docUrl, commentId || source.anchor || ''),
    commentId: commentId,
    replyCount: Number(source.replyCount) || 0,
    replies: Array.isArray(source.replies) ? source.replies : [],
    resolved: !!source.resolved,
  };
}

function rememberDoc(items, seen, item) {
  const key = item.commentId || item.href || '';
  if (key && seen[key]) return;
  if (key) seen[key] = true;
  items.push(item);
}

export function threadEntries(hub, home, options) {
  const items = [];
  const seen = {};
  const staff = !!(options && options.staff);
  const viewer = String((options && options.viewerEmail) || '').trim().toLowerCase();
  const docUrl = home && home.links ? home.links.doc : '';
  ((hub && hub.tickets) || []).forEach(function(ticket) {
    if (!ticket || ticket.route === 'coordinator') return;
    const ticketIsDoc = isDocComment(ticket);
    (ticket.messages || []).forEach(function(message) {
      if (!message) return;
      const at = message.createdAt || ticket.lastUpdated || ticket.createdAt || '';
      const who = threadAuthor(message, staff, viewer, home);
      if (ticketIsDoc || isDocComment(message)) {
        rememberDoc(items, seen, docThreadItem(message, docUrl, at, who.author));
        return;
      }
      items.push({
        type: 'chat',
        at: at,
        mine: who.mine,
        author: who.author,
        body: message.body || '',
      });
    });
  });
  ((home && home.docComments) || []).forEach(function(comment) {
    if (!comment) return;
    rememberDoc(items, seen, docThreadItem(
      comment,
      docUrl,
      comment.at || comment.modifiedAt || comment.createdAt || '',
      comment.author || comment.authorName || 'Comment',
    ));
  });
  items.sort(function(left, right) { return String(left.at).localeCompare(String(right.at)); });
  return items;
}

function replyBlock(item) {
  const list = Array.isArray(item.replies) ? item.replies.filter(function(reply) { return reply && (reply.body || reply.author); }) : [];
  const count = Number(item.replyCount) || list.length;
  if (!list.length) return count ? `<p class="muted">${count} ${count === 1 ? 'reply' : 'replies'} in this thread</p>` : '';
  const shown = list.slice(-3);
  const lines = shown.map(function(reply) {
    return `<p><strong>${escapeHtml(reply.author || 'Reply')}</strong> ${escapeHtml(reply.body || '')}</p>`;
  }).join('');
  const more = count > shown.length ? `<p class="muted">${count} replies in this thread</p>` : '';
  return `<div class="ee-doc-replies">${lines}${more}</div>`;
}

/** One card per Drive thread. Replies stay inside the card. */
export function docCommentCardHtml(item) {
  const quote = item.quote ? `<blockquote>${escapeHtml(item.quote)}</blockquote>` : '';
  const resolved = item.resolved ? '<p class="muted">Resolved</p>' : '';
  const link = item.href
    ? `<p><a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">Open in Google Docs</a></p>`
    : '<p class="muted">No Doc link is available for this comment.</p>';
  return `<article class="ee-doc-comment"><p class="eyebrow">Doc comment</p><strong>${escapeHtml(item.author || 'Comment')}</strong>${quote}<p>${escapeHtml(item.body || '')}</p>${replyBlock(item)}${resolved}${link}</article>`;
}

let detachStage = null;

/**
 * Stage arrows cycle 0→1→2→3→4→0. Desktop pages 1–3 share one strip.
 * 3↔4 reorders that strip and settles with chat at ⅓ and the document at ⅔.
 * Mobile snaps one pane at a time.
 */
export function bindEeStage(root, options) {
  if (detachStage) detachStage();
  detachStage = null;
  if (!root) return function() {};
  const opts = options || {};
  const track = root.querySelector('[data-ee-track]');
  const chip = root.querySelector('[data-ee-chip]');
  if (!track || typeof window.matchMedia !== 'function') return function() {};
  const mq = window.matchMedia('(max-width: ' + EE_MOBILE_MAX + 'px)');
  let page = clampEePage(root.getAttribute('data-page') || opts.page || 0);
  let animating = false;
  const duration = 650;

  function isMobile() { return !!mq.matches; }

  function syncMobile() { root.classList.toggle('is-mobile', isMobile()); }

  function paintChip() {
    if (!chip) return;
    chip.innerHTML = '<b>' + page + '</b> ' + escapeHtml(pageTitle(page, isMobile()));
  }

  function markPanes() {
    const desktop = {
      0: ['doc'],
      1: ['doc', 'journey'],
      2: ['journey', 'calendar'],
      3: ['meetings', 'chat'],
      4: ['chat', 'doc'],
    };
    const phone = { 0: ['doc'], 1: ['journey'], 2: ['calendar'], 3: ['meetings'], 4: ['chat'] };
    const visible = (isMobile() ? phone : desktop)[page] || ['doc'];
    root.querySelectorAll('[data-ee-pane]').forEach(function(pane) {
      const on = visible.indexOf(pane.getAttribute('data-ee-pane')) >= 0;
      pane.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
  }

  function setTx(px, immediate) {
    if (immediate) track.classList.add('no-anim');
    track.style.setProperty('--strip-tx', px + 'px');
    if (immediate) {
      void track.offsetWidth;
      track.classList.remove('no-anim');
    }
  }

  function clearStrip() {
    track.classList.remove('strip-alt', 'strip-p4');
    root.classList.remove('wrap-anim');
  }

  function stageWidth() { return root.clientWidth || 0; }

  function syncEmbed() {
    const embed = root.querySelector('.gdoc-embed');
    if (!embed) return;
    const src = embed.getAttribute('data-embed-src') || '';
    const frame = embed.querySelector('iframe');
    if (isMobile()) {
      if (frame) frame.remove();
      return;
    }
    if (!src || frame) return;
    const iframe = document.createElement('iframe');
    iframe.className = 'gdoc-frame';
    iframe.title = 'Extended Essay draft';
    iframe.src = src;
    const fallback = embed.querySelector('.gdoc-fallback');
    if (fallback) embed.insertBefore(iframe, fallback);
    else embed.appendChild(iframe);
  }

  function visibleIds() {
    return explicitPages(opts.pages).map(function(row) { return row.id; });
  }

  function stageScope() {
    return root.parentElement || root;
  }

  function placeCarousel(immediate) {
    const windowEl = stageScope().querySelector('[data-ee-carousel-window]');
    if (!windowEl) return;
    const buttons = Array.prototype.slice.call(windowEl.querySelectorAll('[data-open-ee-page]'));
    if (!buttons.length) return;
    const ids = buttons.map(function(button) { return Number(button.getAttribute('data-open-ee-page')); });
    let active = ids.indexOf(page);
    if (active < 0) active = 0;
    const sample = buttons[0].offsetWidth || 168;
    buttons.forEach(function(button, index) {
      const offset = circularOffset(index, active, buttons.length);
      const previous = button.hasAttribute('data-offset') ? Number(button.getAttribute('data-offset')) : offset;
      const jump = Math.abs(offset - previous) > 1;
      if (immediate || jump) button.classList.add('no-anim');
      button.style.transform = 'translateX(' + (offset * sample) + 'px)';
      button.setAttribute('data-offset', String(offset));
      const on = index === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-current', on ? 'page' : 'false');
      if (immediate || jump) {
        void button.offsetWidth;
        button.classList.remove('no-anim');
      }
    });
    const scope = stageScope();
    const prev = scope.querySelector('[data-ee-prev]');
    const next = scope.querySelector('[data-ee-next]');
    if (prev) prev.disabled = buttons.length < 2;
    if (next) next.disabled = buttons.length < 2;
  }

  let carouselReady = false;
  function settled() {
    paintChip();
    markPanes();
    syncEmbed();
    placeCarousel(!carouselReady);
    carouselReady = true;
    if (typeof opts.onPage === 'function') opts.onPage(page, { mobile: isMobile() });
  }

  function onEnd(node, prop, fn) {
    let done = false;
    function finishOnce() {
      if (done) return;
      done = true;
      node.removeEventListener('transitionend', handler);
      fn();
    }
    function handler(event) {
      if (event.target !== node) return;
      if (prop && event.propertyName !== prop) return;
      finishOnce();
    }
    node.addEventListener('transitionend', handler);
    window.setTimeout(finishOnce, duration + 90);
  }

  function applyMobile() {
    clearStrip();
    root.classList.remove('strip-mode');
    root.setAttribute('data-page', String(page));
    setTx(0, true);
    settled();
    animating = false;
  }

  function settleStrip(next) {
    root.classList.add('strip-mode');
    clearStrip();
    if (next === 4) track.classList.add('strip-p4');
    root.setAttribute('data-page', String(next));
    const offset = next === 4 ? 0 : stripOffsetPx(next, stageWidth(), 'strip');
    setTx(offset, true);
    settled();
  }

  function applyPage() {
    if (isMobile()) {
      applyMobile();
      return;
    }
    const next = page;
    const prevStrip = root.classList.contains('strip-mode');
    if (next === 4) {
      settleStrip(4);
      return;
    }
    if (next === 1 || next === 2 || next === 3) {
      if (!prevStrip) {
        root.classList.add('strip-mode');
        clearStrip();
        root.setAttribute('data-page', String(next));
        setTx(next === 1 ? 0 : stripOffsetPx(next, stageWidth(), 'strip'), true);
        window.requestAnimationFrame(function() {
          window.requestAnimationFrame(function() {
            setTx(stripOffsetPx(next, stageWidth(), 'strip'), false);
            settled();
          });
        });
        return;
      }
      const wasPage4 = track.classList.contains('strip-p4');
      root.classList.add('strip-mode');
      track.classList.remove('strip-alt', 'strip-p4');
      root.classList.remove('wrap-anim');
      root.setAttribute('data-page', String(next));
      if (wasPage4) {
        setTx(stripOffsetPx(next, stageWidth(), 'strip'), true);
        settled();
        return;
      }
      window.requestAnimationFrame(function() {
        window.requestAnimationFrame(function() {
          setTx(stripOffsetPx(next, stageWidth(), 'strip'), false);
          settled();
        });
      });
      return;
    }
    clearStrip();
    root.classList.remove('strip-mode');
    root.setAttribute('data-page', '0');
    setTx(0, true);
    settled();
  }

  function goForwardMeetingsToChat() {
    if (isMobile()) {
      page = 4;
      placeCarousel(false);
      applyMobile();
      return;
    }
    animating = true;
    page = 4;
    placeCarousel(false);
    root.classList.add('wrap-anim', 'strip-mode');
    track.classList.remove('strip-p4');
    setTx(stripOffsetPx(3, stageWidth(), 'alt'), true);
    track.classList.add('strip-alt');
    root.setAttribute('data-page', '3');
    window.requestAnimationFrame(function() {
      window.requestAnimationFrame(function() {
        root.setAttribute('data-page', '4');
        setTx(stripOffsetPx(4, stageWidth(), 'alt'), false);
        onEnd(track, 'transform', function() {
          track.classList.add('no-anim');
          track.classList.remove('strip-alt');
          track.classList.add('strip-p4');
          root.classList.remove('wrap-anim');
          root.classList.add('strip-mode');
          root.setAttribute('data-page', '4');
          setTx(0, true);
          animating = false;
          settled();
        });
      });
    });
  }

  function goBackChatToMeetings() {
    if (isMobile()) {
      page = 3;
      placeCarousel(false);
      applyMobile();
      return;
    }
    animating = true;
    page = 3;
    placeCarousel(false);
    root.classList.add('wrap-anim', 'strip-mode');
    track.classList.remove('strip-alt');
    track.classList.add('strip-p4');
    root.setAttribute('data-page', '4');
    setTx(0, true);
    window.requestAnimationFrame(function() {
      window.requestAnimationFrame(function() {
        track.classList.add('no-anim');
        track.classList.remove('strip-p4');
        track.classList.add('strip-alt');
        setTx(stripOffsetPx(4, stageWidth(), 'alt'), true);
        window.requestAnimationFrame(function() {
          window.requestAnimationFrame(function() {
            root.setAttribute('data-page', '3');
            setTx(stripOffsetPx(3, stageWidth(), 'alt'), false);
            onEnd(track, 'transform', function() {
              track.classList.add('no-anim');
              track.classList.remove('strip-alt');
              root.classList.remove('wrap-anim');
              root.classList.add('strip-mode');
              root.setAttribute('data-page', '3');
              setTx(stripOffsetPx(3, stageWidth(), 'strip'), true);
              animating = false;
              settled();
            });
          });
        });
      });
    });
  }

  function step(direction) {
    if (animating) return;
    const ids = visibleIds();
    if (ids.length < 2) return;
    const from = page;
    const next = stepVisiblePage(from, direction, opts.pages);
    if (isMobile()) {
      page = next;
      placeCarousel(false);
      applyMobile();
      return;
    }
    if (from === 3 && next === 4) return goForwardMeetingsToChat();
    if (from === 4 && next === 3) return goBackChatToMeetings();
    animating = true;
    page = next;
    placeCarousel(false);
    applyPage();
    const node = next === 0 ? (root.querySelector('.ee-pane-doc') || track) : track;
    onEnd(node, next === 0 ? '' : 'transform', function() {
      animating = false;
    });
  }

  function goTo(next) {
    const target = clampEePage(next);
    if (visibleIds().indexOf(target) < 0) return;
    if (animating || target === page) return;
    if (isMobile()) {
      page = target;
      placeCarousel(false);
      applyMobile();
      return;
    }
    if (page === 3 && target === 4) return goForwardMeetingsToChat();
    if (page === 4 && target === 3) return goBackChatToMeetings();
    animating = true;
    page = target;
    placeCarousel(false);
    applyPage();
    onEnd(track, target === 0 ? '' : 'transform', function() { animating = false; });
  }

  syncMobile();
  if (isMobile()) applyMobile();
  else if (page === 0) {
    root.classList.remove('strip-mode');
    clearStrip();
    root.setAttribute('data-page', '0');
    setTx(0, true);
    settled();
  } else settleStrip(page);

  const scope = stageScope();
  const prevBtn = scope.querySelector('[data-ee-prev]');
  const nextBtn = scope.querySelector('[data-ee-next]');
  function onPrev(event) { event.preventDefault(); step(-1); }
  function onNext(event) { event.preventDefault(); step(1); }
  if (prevBtn) prevBtn.addEventListener('click', onPrev);
  if (nextBtn) nextBtn.addEventListener('click', onNext);
  function onJump(event) {
    const jump = event.target.closest('[data-open-ee-page]');
    if (!jump || !scope.contains(jump)) return;
    event.preventDefault();
    goTo(jump.getAttribute('data-open-ee-page'));
  }
  scope.addEventListener('click', onJump);

  let startX = 0;
  let startY = 0;
  let tracking = false;
  function onTouchStart(event) {
    if (!event.touches || event.touches.length !== 1) return;
    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, select, iframe, a, button')) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    tracking = true;
  }
  function onTouchEnd(event) {
    if (!tracking || !event.changedTouches || !event.changedTouches.length) return;
    tracking = false;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) step(1);
    else step(-1);
  }
  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchend', onTouchEnd, { passive: true });

  function onKey(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (!root.isConnected) return;
    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && target.closest && target.closest('[data-slider-control], [role="slider"]')) return;
    event.preventDefault();
    if (event.key === 'ArrowRight') step(1);
    else step(-1);
  }
  window.addEventListener('keydown', onKey);

  function onViewport() {
    const wasMobile = root.classList.contains('is-mobile');
    syncMobile();
    const nowMobile = isMobile();
    animating = false;
    if (wasMobile !== nowMobile) {
      if (nowMobile) applyMobile();
      else if (page === 0) {
        root.classList.remove('strip-mode');
        clearStrip();
        root.setAttribute('data-page', '0');
        setTx(0, true);
        settled();
      } else settleStrip(page);
      return;
    }
    if (nowMobile) {
      setTx(0, true);
      placeCarousel(true);
      return;
    }
    if (page === 1 || page === 2 || page === 3) {
      const mode = track.classList.contains('strip-alt') ? 'alt' : 'strip';
      setTx(stripOffsetPx(page, stageWidth(), mode), true);
    } else setTx(0, true);
    placeCarousel(true);
  }
  window.addEventListener('resize', onViewport);
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onViewport);
  else if (typeof mq.addListener === 'function') mq.addListener(onViewport);

  detachStage = function() {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onViewport);
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onViewport);
    else if (typeof mq.removeListener === 'function') mq.removeListener(onViewport);
    if (prevBtn) prevBtn.removeEventListener('click', onPrev);
    if (nextBtn) nextBtn.removeEventListener('click', onNext);
    scope.removeEventListener('click', onJump);
    root.removeEventListener('touchstart', onTouchStart);
    root.removeEventListener('touchend', onTouchEnd);
    detachStage = null;
  };
  return detachStage;
}
