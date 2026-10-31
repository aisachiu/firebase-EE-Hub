import { clampEePage, stepEePage } from '../shared/eePage.js';
import { escapeHtml } from '../shared/html.js';

export { clampEePage, stepEePage };

export const EE_MOBILE_MAX = 700;

export const EE_PAGES = [
  { id: 0, title: 'Document', mobileTitle: 'Document' },
  { id: 1, title: 'Document & Journey', mobileTitle: 'Journey' },
  { id: 2, title: 'Journey & Calendar', mobileTitle: 'Calendar' },
  { id: 3, title: 'Supervisor & Meetings', mobileTitle: 'Supervisor & Meetings' },
  { id: 4, title: 'Chat & Document', mobileTitle: 'Chat' },
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

export function threadEntries(hub, home) {
  const items = [];
  const docUrl = home && home.links ? home.links.doc : '';
  ((hub && hub.tickets) || []).forEach(function(ticket) {
    if (!ticket || ticket.route === 'coordinator') return;
    const ticketIsDoc = isDocComment(ticket);
    (ticket.messages || []).forEach(function(message) {
      if (!message) return;
      const at = message.createdAt || ticket.lastUpdated || ticket.createdAt || '';
      if (ticketIsDoc || isDocComment(message)) {
        items.push({
          type: 'doc',
          at: at,
          author: message.authorName || (message.authorRole === 'student' ? 'You' : 'Supervisor'),
          quote: message.quote || '',
          body: message.body || '',
          href: docCommentHref(message.docUrl || docUrl, message.commentId || message.disco || message.anchor || ''),
        });
        return;
      }
      items.push({
        type: 'chat',
        at: at,
        mine: message.authorRole === 'student',
        author: message.authorRole === 'student' ? 'You' : (message.authorName || 'Supervisor'),
        body: message.body || '',
      });
    });
  });
  ((home && home.docComments) || []).forEach(function(comment) {
    if (!comment) return;
    items.push({
      type: 'doc',
      at: comment.at || comment.createdAt || '',
      author: comment.author || comment.authorName || 'Comment',
      quote: comment.quote || '',
      body: comment.body || comment.text || '',
      href: docCommentHref(comment.docUrl || docUrl, comment.commentId || comment.disco || comment.anchor || ''),
    });
  });
  items.sort(function(left, right) { return String(left.at).localeCompare(String(right.at)); });
  return items;
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

  function settled() {
    paintChip();
    markPanes();
    syncEmbed();
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
      applyMobile();
      return;
    }
    animating = true;
    page = 4;
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
      applyMobile();
      return;
    }
    animating = true;
    page = 3;
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
    const from = page;
    const next = stepEePage(from, direction);
    if (isMobile()) {
      page = next;
      applyMobile();
      return;
    }
    if (from === 3 && next === 4) return goForwardMeetingsToChat();
    if (from === 4 && next === 3) return goBackChatToMeetings();
    animating = true;
    page = next;
    applyPage();
    const node = next === 0 ? (root.querySelector('.ee-pane-doc') || track) : track;
    onEnd(node, next === 0 ? '' : 'transform', function() {
      animating = false;
    });
  }

  function goTo(next) {
    const target = clampEePage(next);
    if (animating || target === page) return;
    if (isMobile()) {
      page = target;
      applyMobile();
      return;
    }
    if (page === 3 && target === 4) return goForwardMeetingsToChat();
    if (page === 4 && target === 3) return goBackChatToMeetings();
    animating = true;
    page = target;
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

  const prevBtn = root.querySelector('[data-ee-prev]');
  const nextBtn = root.querySelector('[data-ee-next]');
  function onPrev(event) { event.preventDefault(); step(-1); }
  function onNext(event) { event.preventDefault(); step(1); }
  if (prevBtn) prevBtn.addEventListener('click', onPrev);
  if (nextBtn) nextBtn.addEventListener('click', onNext);
  function onJump(event) {
    const jump = event.target.closest('[data-open-ee-page]');
    if (!jump || !root.contains(jump)) return;
    event.preventDefault();
    goTo(jump.getAttribute('data-open-ee-page'));
  }
  root.addEventListener('click', onJump);

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
      return;
    }
    if (page === 1 || page === 2 || page === 3) {
      const mode = track.classList.contains('strip-alt') ? 'alt' : 'strip';
      setTx(stripOffsetPx(page, stageWidth(), mode), true);
    } else setTx(0, true);
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
    root.removeEventListener('click', onJump);
    root.removeEventListener('touchstart', onTouchStart);
    root.removeEventListener('touchend', onTouchEnd);
    detachStage = null;
  };
  return detachStage;
}
