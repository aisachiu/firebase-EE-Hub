import { callServer } from '../shared/api.js';
import { rememberMessageDesk } from '../shared/desk.js';
import { showError } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import {
  bindTicketList,
  openFocusedTicket,
  openTicketDialog,
  refreshMessageDesk,
  renderTicket,
  routeNote,
  syncStudentUnread,
} from '../shared/tickets.js';

export { routeNote, syncStudentUnread };

export function renderStudentHelp() {
  advanceScene();
  const main = document.getElementById('main');
  const hub = state.messageDesks.student;
  if (hub) {
    syncStudentUnread(hub);
    paintStudentMessages(hub, main, { page: true });
    return;
  }
  main.innerHTML = loadingLine('Loading messages...');
  callServer('getTicketHub').then(function(loaded) {
    rememberMessageDesk(loaded, 'student');
    syncStudentUnread(loaded);
    if (state.section === 'supervisor' || state.section === 'help') paintStudentMessages(loaded, main, { page: true });
  }).catch(showError);
}

export function paintStudentMessages(hub, host, options) {
  const main = host || document.getElementById('main');
  if (!main) return;
  const config = options || {};
  const faqs = hub.faqs || [];
  const tickets = hub.tickets || [];
  const compact = !!config.compact;
  const head = config.page
    ? `<div class="page-head"><div><p class="eyebrow">Help</p><h1>Help</h1><p class="lede">Answers, and messages with your supervisor or the EE Coordinator.</p></div><div class="page-actions"><button type="button" class="button secondary" id="refresh-messages">Refresh</button><button type="button" class="button" id="new-ticket">New message</button></div></div>`
    : `<div class="module-head"><h2>Messages</h2><div class="page-actions"><button type="button" class="button secondary" id="refresh-messages">Refresh</button><button type="button" class="button" id="new-ticket">New message</button></div></div>`;
  const answers = compact
    ? ''
    : `<section><h3>Quick answers</h3><div class="toolbar"><input id="faq-search" type="search" placeholder="Search common questions" aria-label="Search common questions"></div>
    <div class="faq-list" id="faq-list">${faqs.length ? faqs.map(renderFaq).join('') : '<div class="empty">No published answers yet.</div>'}</div></section>`;
  main.innerHTML = `${head}
    ${answers}
    <section class="section-gap"><h3>My messages</h3><div class="ticket-list" id="ticket-list">${tickets.length ? tickets.map(function(ticket) { return renderTicket(ticket, false); }).join('') : '<div class="empty">You have not sent a message yet.</div>'}</div></section>`;
  const search = main.querySelector('#faq-search');
  if (search) search.addEventListener('input', function(event) {
    const query = event.target.value.trim().toLowerCase();
    main.querySelectorAll('[data-faq]').forEach(function(card) {
      card.classList.toggle('hidden', query && card.dataset.faq.indexOf(query) < 0);
    });
  });
  const create = main.querySelector('#new-ticket');
  if (create) create.addEventListener('click', function() { openTicketDialog(hub.categories || []); });
  const refresh = main.querySelector('#refresh-messages');
  if (refresh) refresh.addEventListener('click', function(event) { refreshMessageDesk(event.currentTarget, false); });
  bindTicketList(main, tickets, false);
  openFocusedTicket(main);
}

export function renderFaq(faq) {
  return `<article class="faq" data-faq="${escapeHtml((faq.question + ' ' + faq.answer).toLowerCase())}"><strong>${escapeHtml(faq.question)}</strong><p>${escapeHtml(faq.answer)}</p></article>`;
}
