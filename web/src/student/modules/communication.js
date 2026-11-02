import { callServer, dispatchServer, quietServer } from '../../shared/api.js';
import { showError, showSuccess } from '../../shared/feedback.js';
import { escapeHtml, shortDate } from '../../shared/html.js';
import { loadingLine } from '../../shared/loading.js';
import { state } from '../../shared/state.js';
import { chatPaneOpen, docCommentCardHtml, EE_MOBILE_MAX, previewPage, threadEntries } from '../rotary.js';

export const id = 'communication';

/** Supervisors, their EE Lead, and coordinators compose. Browse staff keep Doc comments without a compose box. */
export function staffChatComposeEnabled(home) {
  if (!home || !home.staffView) return false;
  const view = home.viewAs;
  if (view !== 'supervisor' && view !== 'coordinator' && view !== 'lead') return false;
  if (home.canSendChat === false) return false;
  return true;
}

const COMMENT_RESYNC_MS = 10000;
const commentSyncPending = {};
const commentSyncedAt = {};

export function render(home, context) {
  const thread = context && context.thread;
  const compact = context && context.slot === 'compact';
  if (home && home.staffView && !thread) {
    return `<div class="ee-chat"><h2>Chat</h2><p class="muted">Open Supervisor Chat to read this conversation.</p></div>`;
  }
  if (thread) return `<div class="ee-chat" data-communication-host><p class="muted">Loading messages...</p></div>`;
  return `<div data-communication-host>${compact ? '<p class="muted">Loading messages...</p>' : loadingLine('Loading messages...')}</div>`;
}

export function mount(host, home, context) {
  const target = host.querySelector('[data-communication-host]') || host;
  const thread = context && context.thread;
  if (home && home.staffView) {
    if (!thread) return;
    if (staffChatComposeEnabled(home)) {
      mountStaffChat(host, home);
      return;
    }
    paintSupervisorThread({ entries: [], canCompose: false }, target, home);
    return;
  }
  const hub = state.studentChat;
  if (hub) {
    markChatRead(hub, home);
    paintSupervisorThread(hub, target, home);
    return;
  }
  callServer('getStudentChat').then(function(loaded) {
    if (!target.isConnected) return;
    state.studentChat = loaded;
    markChatRead(loaded, home);
    if (!communicationStillOpen()) return;
    paintSupervisorThread(loaded, target, home);
  }).catch(function(error) {
    if (!target.isConnected) return;
    target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
    showError(error);
  });
}

function mountStaffChat(host, home) {
  const target = host.querySelector('[data-communication-host]') || host;
  const cached = state.staffStudentChat;
  if (cached && cached.studentEmail === home.email && cached.cohortId === (home.cohort || cached.cohortId)) {
    markChatRead(cached, home);
    paintSupervisorThread(cached, target, home);
    return;
  }
  loadStaffStudentChat(home).then(function(loaded) {
    if (!target.isConnected) return;
    state.staffStudentChat = loaded;
    markChatRead(loaded, home);
    paintSupervisorThread(loaded, target, home);
  }).catch(function(error) {
    if (!target.isConnected) return;
    target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
    showError(error);
  });
}

function loadStaffStudentChat(home) {
  return callServer('getStaffStudentChat', home.email, home.cohort || '', home.viewAs || state.actingAs || '');
}

function staffChatHub(home) {
  const cached = state.staffStudentChat;
  if (cached && home && cached.studentEmail === home.email) return cached;
  return { entries: [] };
}

function markChatRead(loaded, home) {
  const staff = !!(home && home.staffView);
  if (staff) {
    if (!state.staffHome || !Array.isArray(state.staffHome.unreadTickets)) return;
    const email = String((loaded && loaded.studentEmail) || (home && home.email) || '').trim().toLowerCase();
    const cohort = String((loaded && loaded.cohortId) || (home && home.cohort) || '');
    const before = state.staffHome.unreadTickets.length;
    state.staffHome.unreadTickets = state.staffHome.unreadTickets.filter(function(item) {
      if (String(item.studentEmail || '').trim().toLowerCase() !== email) return true;
      return !!(cohort && item.cohortId && item.cohortId !== cohort);
    });
    const removed = before - state.staffHome.unreadTickets.length;
    if (removed) state.staffHome.unreadTicketCount = Math.max(0, (state.staffHome.unreadTicketCount || 0) - removed);
    return;
  }
  state.openingChatUnread = 0;
  if (state.studentHome) {
    state.studentHome.unreadTicketCount = 0;
    state.studentHome.unreadTickets = [];
  }
}

function communicationStillOpen() {
  if (state.user && state.user.role === 'student') {
    return state.section === 'my-ee' || state.section === 'supervisor' || state.section === 'document';
  }
  const page = previewPage(state.staffPreviewView);
  return page === 3 || page === 4;
}

export function essayCommentSyncArgs(home) {
  if (home && home.staffView) return [home.email || '', home.cohort || '', home.viewAs || state.actingAs || ''];
  return [];
}

function commentSyncKey(home) {
  const who = home && home.staffView ? 'staff' : 'student';
  const email = (home && home.email) || 'self';
  const doc = home && home.links ? home.links.doc || '' : '';
  return who + '|' + email + '|' + doc;
}

function repaintChat(home) {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const host = document.querySelector('[data-ee-pane="chat"] [data-communication-host]');
  if (!host || host.isConnected === false) return;
  const staff = !!(home && home.staffView);
  const hub = staff ? staffChatHub(home) : (state.studentChat || { entries: [] });
  paintSupervisorThread(hub, host, home);
}

/** Incremental Drive sync for the open chat. A short pause collapses a remount of the same panel. */
export function refreshEssayComments(home) {
  if (typeof window === 'undefined' || typeof window.eeCall !== 'function') return Promise.resolve(null);
  const key = commentSyncKey(home);
  if (commentSyncPending[key]) return commentSyncPending[key];
  if (commentSyncedAt[key] && Date.now() - commentSyncedAt[key] < COMMENT_RESYNC_MS) return Promise.resolve(null);
  commentSyncPending[key] = quietServer('syncEssayDocComments', essayCommentSyncArgs(home)).then(function(result) {
    commentSyncedAt[key] = Date.now();
    if (result && Array.isArray(result.comments) && home) home.docComments = result.comments;
    repaintChat(home);
    return result;
  }).catch(function() {
    return null;
  }).finally(function() {
    delete commentSyncPending[key];
  });
  return commentSyncPending[key];
}

export function syncChatCommentsIfOpen(home, page) {
  const mobile = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: ' + EE_MOBILE_MAX + 'px)').matches;
  if (!chatPaneOpen(page, !!mobile)) return Promise.resolve(null);
  return refreshEssayComments(home);
}

export function supervisorThreadHtml(hub, home) {
  const staff = !!(home && home.staffView);
  const items = threadEntries(hub, home, staff ? { staff: true, viewerEmail: (hub && hub.viewerEmail) || '' } : null);
  let lastDay = '';
  const body = items.map(function(item) {
    const day = shortDate(item.at) || '';
    const gap = day && day !== lastDay ? `<p class="ee-chat-day">${escapeHtml(day)}</p>` : '';
    if (day) lastDay = day;
    if (item.type === 'doc') return gap + docCommentCardHtml(item);
    return gap + `<article class="ee-bubble${item.mine ? ' mine' : ''}"><strong>${escapeHtml(item.author || 'Supervisor')}</strong><p>${escapeHtml(item.body || '')}</p></article>`;
  }).join('');
  const compose = showCompose(hub, home);
  const empty = !staff
    ? 'No messages with your supervisor yet.'
    : (compose ? 'No messages with this student yet.' : 'No Doc comments in this chat yet.');
  const label = staff ? 'Message to this student' : 'Message to your supervisor';
  const placeholder = staff ? 'Message this student' : 'Message your supervisor';
  const form = compose
    ? `<form class="ee-chat-compose" data-chat-form><textarea maxlength="2000" aria-label="${label}" placeholder="${placeholder}"></textarea><button type="submit" class="button">Send</button></form>`
    : '';
  return `<div class="ee-chat-bar"><h2>Chat</h2></div>
    <div class="ee-chat-scroll" data-chat-scroll>${body || '<div class="empty">' + empty + '</div>'}</div>
    ${form}`;
}

function showCompose(hub, home) {
  if (!home || !home.staffView) return true;
  if (hub && hub.canCompose === false) return false;
  return staffChatComposeEnabled(home);
}

export function paintSupervisorThread(hub, host, home, draft) {
  if (!host) return;
  host.innerHTML = supervisorThreadHtml(hub, home);
  const scroller = host.querySelector('[data-chat-scroll]');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const form = host.querySelector('[data-chat-form]');
  if (form) form.addEventListener('submit', function(event) {
    event.preventDefault();
    const input = form.querySelector('textarea');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    sendSupervisorChat(text, hub, host, home, input);
  });
  if (draft && form) {
    const input = form.querySelector('textarea');
    if (input) input.value = draft;
  }
}

function sendSupervisorChat(text, hub, host, home, input) {
  if (text.length > 2000) {
    showError(new Error('Messages must be 2,000 characters or fewer.'));
    return;
  }
  const staff = !!(home && home.staffView);
  const token = hub && hub.lastUpdated ? hub.lastUpdated : '';
  const send = staff
    ? dispatchServer('sendStaffStudentChat', [home.email, home.cohort || '', text, token, home.viewAs || state.actingAs || ''])
    : dispatchServer('sendStudentChat', [text, token]);
  if (input) input.disabled = true;
  send.then(function() {
    return staff ? loadStaffStudentChat(home) : callServer('getStudentChat');
  }).then(function(loaded) {
    if (!host.isConnected) return;
    if (staff) state.staffStudentChat = loaded;
    else state.studentChat = loaded;
    markChatRead(loaded, home);
    paintSupervisorThread(loaded, host, home);
    showSuccess('Message sent.');
  }).catch(function(error) {
    showError(error);
    if (!staff || !host.isConnected) {
      if (input) input.disabled = false;
      return;
    }
    loadStaffStudentChat(home).then(function(loaded) {
      if (!host.isConnected) return;
      state.staffStudentChat = loaded;
      paintSupervisorThread(loaded, host, home, text);
    }).catch(function() {
      if (input && input.isConnected) input.disabled = false;
    });
  });
}
