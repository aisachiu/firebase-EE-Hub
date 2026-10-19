import { callServer } from '../shared/api.js';
import { rememberMessageDesk } from '../shared/desk.js';
import { showError } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import {
  bindTicketList,
  openTicketDialog,
  refreshMessageDesk,
  renderTicket,
  syncStudentUnread,
} from '../shared/tickets.js';
import { openFocusedTicket } from '../staff/messages.js';

export function renderStudentHelp() {
  advanceScene();
  const main = document.getElementById('main');
  const hub = state.messageDesks.student;
  if (hub) {
    syncStudentUnread(hub);
    paintStudentHelp(hub);
    return;
  }
  main.innerHTML = loadingLine('Loading messages...');
  callServer('getTicketHub').then(function(loaded) {
    rememberMessageDesk(loaded, 'student');
    syncStudentUnread(loaded);
    if (state.section === 'help') paintStudentHelp(loaded);
  }).catch(showError);
}

export function paintStudentHelp(hub) {
  const main = document.getElementById('main');
  const faqs = hub.faqs || [];
  const tickets = hub.tickets || [];
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Help</p><h1>Messages</h1><p class="lede">Search common answers, or send a message to your supervisor or the EE Coordinator.</p></div><div class="page-actions"><button type="button" class="button secondary" id="refresh-messages">Refresh</button><button type="button" class="button" id="new-ticket">New message</button></div></div>
    <section><h2>Quick answers</h2><div class="toolbar"><input id="faq-search" type="search" placeholder="Search common questions" aria-label="Search common questions"></div>
    <div class="faq-list" id="faq-list">${faqs.length ? faqs.map(renderFaq).join('') : '<div class="empty">No published answers yet.</div>'}</div></section>
    <section class="section-gap"><h2>My messages</h2><div class="ticket-list" id="ticket-list">${tickets.length ? tickets.map(function(ticket) { return renderTicket(ticket, false); }).join('') : '<div class="empty">You have not sent a message yet.</div>'}</div></section>`;
  document.getElementById('faq-search').addEventListener('input', function(event) {
    const query = event.target.value.trim().toLowerCase();
    main.querySelectorAll('[data-faq]').forEach(function(card) {
      card.classList.toggle('hidden', query && card.dataset.faq.indexOf(query) < 0);
    });
  });
  document.getElementById('new-ticket').addEventListener('click', function() { openTicketDialog(hub.categories || []); });
  document.getElementById('refresh-messages').addEventListener('click', function(event) { refreshMessageDesk(event.currentTarget, false); });
  bindTicketList(main, tickets, false);
  openFocusedTicket(main);
}

export function renderFaq(faq) {
  return `<article class="faq" data-faq="${escapeHtml((faq.question + ' ' + faq.answer).toLowerCase())}"><strong>${escapeHtml(faq.question)}</strong><p>${escapeHtml(faq.answer)}</p></article>`;
}

export function routeNote(route) {
  return route === 'coordinator' ? 'This message goes to the EE Coordinator.' : 'This message goes to your supervisor.';
}
