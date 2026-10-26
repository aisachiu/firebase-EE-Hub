import { callServer } from '../shared/api.js';
import { rememberMessageDesk } from '../shared/desk.js';
import { showError } from '../shared/feedback.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { bindTicketList, refreshMessageDesk, renderTicket, syncStaffUnread } from '../shared/tickets.js';

export function renderStaffTickets() {
  advanceScene();
  const main = document.getElementById('main');
  const hub = state.messageDesks[state.actingAs];
  if (hub) {
    syncStaffUnread(hub);
    paintStaffTickets(hub);
    return;
  }
  if (state.actingAs !== 'supervisor' && state.actingAs !== 'coordinator') {
    paintStaffTickets({ viewAs: state.actingAs, tickets: [], unreadCount: 0, categories: [] });
    return;
  }
  const requested = state.actingAs;
  main.innerHTML = loadingLine('Loading messages...');
  callServer('getStaffTickets', requested).then(function(loaded) {
    rememberMessageDesk(loaded, requested);
    syncStaffUnread(loaded);
    if (state.section === 'tickets' && state.actingAs === requested) paintStaffTickets(loaded);
  }).catch(showError);
}

export function paintStaffTickets(hub) {
  const main = document.getElementById('main');
  const tickets = hub.tickets || [];
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Help</p><h1>Messages</h1><p class="lede">${hub.viewAs === 'supervisor' ? 'Messages from your advisees.' : 'Messages routed to the EE Coordinator, plus supervisor messages that have no assignee yet.'}</p></div><div class="page-actions"><span class="muted" id="message-count">${tickets.length} message${tickets.length === 1 ? '' : 's'}</span><button type="button" class="button secondary" id="refresh-messages">Refresh</button></div></div>
    <div class="ticket-list" id="ticket-list">${tickets.length ? tickets.map(function(ticket) { return renderTicket(ticket, true); }).join('') : '<div class="empty">No messages in this queue.</div>'}</div>`;
  document.getElementById('refresh-messages').addEventListener('click', function(event) { refreshMessageDesk(event.currentTarget, true); });
  bindTicketList(main, tickets, true);
  openFocusedTicket(main);
}

export function openFocusedTicket(main) {
  if (!state.focusTicket || !main) return;
  const id = state.focusTicket;
  state.focusTicket = '';
  const details = main.querySelector('details[data-ticket="' + id.replace(/"/g, '') + '"]');
  if (details) details.open = true;
}
