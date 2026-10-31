import { callServer, dispatchServer } from '../../shared/api.js';
import { rememberMessageDesk } from '../../shared/desk.js';
import { showError, showSuccess } from '../../shared/feedback.js';
import { escapeHtml, shortDate } from '../../shared/html.js';
import { loadingLine } from '../../shared/loading.js';
import { state } from '../../shared/state.js';
import { openStudentSection } from '../home.js';
import { paintStudentMessages, syncStudentUnread } from '../help.js';
import { previewPage, threadEntries } from '../rotary.js';

export const id = 'communication';

export function render(home, context) {
  if (home && home.staffView) {
    return `<div class="ee-chat"><h2>Chat</h2><p class="muted">This student's messages stay on your Messages tab. This preview does not open their inbox.</p></div>`;
  }
  const thread = context && context.thread;
  const compact = context && context.slot === 'compact';
  if (thread) return `<div class="ee-chat" data-communication-host><p class="muted">Loading messages...</p></div>`;
  return `<div data-communication-host>${compact ? '<p class="muted">Loading messages...</p>' : loadingLine('Loading messages...')}</div>`;
}

export function mount(host, home, context) {
  if (home && home.staffView) return;
  const target = host.querySelector('[data-communication-host]') || host;
  const thread = context && context.thread;
  const compact = context && context.slot === 'compact';
  const hub = state.messageDesks.student;
  if (hub) {
    syncStudentUnread(hub);
    if (thread) paintSupervisorThread(hub, target, home);
    else paintStudentMessages(hub, target, { compact: compact });
    return;
  }
  callServer('getTicketHub').then(function(loaded) {
    if (!target.isConnected) return;
    rememberMessageDesk(loaded, 'student');
    syncStudentUnread(loaded);
    if (!communicationStillOpen()) return;
    if (thread) paintSupervisorThread(loaded, target, home);
    else paintStudentMessages(loaded, target, { compact: compact });
  }).catch(function(error) {
    if (!target.isConnected) return;
    target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
    showError(error);
  });
}

function communicationStillOpen() {
  if (state.user && state.user.role === 'student') {
    return state.section === 'my-ee' || state.section === 'help' || state.section === 'supervisor' || state.section === 'document';
  }
  const page = previewPage(state.staffPreviewView);
  return page === 3 || page === 4;
}

export function paintSupervisorThread(hub, host, home) {
  if (!host) return;
  const items = threadEntries(hub, home);
  let lastDay = '';
  const body = items.map(function(item) {
    const day = shortDate(item.at) || '';
    const gap = day && day !== lastDay ? `<p class="ee-chat-day">${escapeHtml(day)}</p>` : '';
    if (day) lastDay = day;
    if (item.type === 'doc') return gap + docCommentCard(item);
    return gap + `<article class="ee-bubble${item.mine ? ' mine' : ''}"><strong>${escapeHtml(item.author || 'Supervisor')}</strong><p>${escapeHtml(item.body || '')}</p></article>`;
  }).join('');
  host.innerHTML = `<div class="ee-chat-bar"><h2>Chat</h2><button type="button" class="button secondary" data-chat-help>Help</button></div>
    <div class="ee-chat-scroll" data-chat-scroll>${body || '<div class="empty">No messages with your supervisor yet.</div>'}</div>
    <form class="ee-chat-compose" data-chat-form><textarea maxlength="2000" aria-label="Message to your supervisor" placeholder="Message your supervisor"></textarea><button type="submit" class="button">Send</button></form>`;
  const scroller = host.querySelector('[data-chat-scroll]');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const help = host.querySelector('[data-chat-help]');
  if (help) help.addEventListener('click', function() { openStudentSection('help'); });
  const form = host.querySelector('[data-chat-form]');
  if (form) form.addEventListener('submit', function(event) {
    event.preventDefault();
    const input = form.querySelector('textarea');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    sendSupervisorChat(text, hub, host, home, input);
  });
}

function docCommentCard(item) {
  const quote = item.quote ? `<blockquote>${escapeHtml(item.quote)}</blockquote>` : '';
  const link = item.href ? `<p><a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">Open in Google Docs</a></p>` : '<p class="muted">No Doc link is available for this comment.</p>';
  return `<article class="ee-doc-comment"><p class="eyebrow">Doc comment</p><strong>${escapeHtml(item.author || 'Comment')}</strong>${quote}<p>${escapeHtml(item.body || '')}</p>${link}</article>`;
}

function supervisorCategory(hub) {
  const categories = (hub && hub.categories) || [];
  return categories.filter(function(category) { return category.route === 'supervisor'; })[0] || null;
}

function latestSupervisorTicket(hub) {
  const rows = ((hub && hub.tickets) || []).filter(function(ticket) {
    return ticket && ticket.route !== 'coordinator' && ticket.kind !== 'doc-comment' && !/doc(ument)? comment/i.test(String(ticket.category || ''));
  });
  rows.sort(function(left, right) { return String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || '')); });
  return rows[0] || null;
}

function chatTitle(body) {
  const line = String(body || '').trim().split('\n')[0] || 'Message';
  return line.length > 80 ? line.slice(0, 77) + '...' : line;
}

function sendSupervisorChat(text, hub, host, home, input) {
  if (text.length > 2000) {
    showError(new Error('Messages must be 2,000 characters or fewer.'));
    return;
  }
  const ticket = latestSupervisorTicket(hub);
  const category = supervisorCategory(hub);
  const send = ticket
    ? dispatchServer('replyTicket', [ticket.ticketId, text, ticket.lastUpdated || '', ''])
    : (category
      ? dispatchServer('createTicket', [{ category: category.name, title: chatTitle(text), body: text }])
      : Promise.reject(new Error('No message category is available yet. Open Help to send a message.')));
  if (input) input.disabled = true;
  send.then(function() {
    return callServer('getTicketHub');
  }).then(function(loaded) {
    if (!host.isConnected) return;
    rememberMessageDesk(loaded, 'student');
    syncStudentUnread(loaded);
    paintSupervisorThread(loaded, host, home);
    showSuccess('Message sent.');
  }).catch(function(error) {
    if (input) input.disabled = false;
    showError(error);
  });
}
