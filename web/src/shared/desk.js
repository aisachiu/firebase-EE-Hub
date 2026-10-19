import { state } from './state.js';

export function rememberMessageDesk(hub, key) {
  if (!hub) return;
  state.messageDesks[key] = hub;
  state.ticketHub = hub;
}

export function rememberOpeningMessages(payload) {
  if (!payload) return;
  if (payload.student) rememberMessageDesk(payload.student, 'student');
  if (payload.coordinator) rememberMessageDesk(payload.coordinator, 'coordinator');
  if (payload.supervisor) rememberMessageDesk(payload.supervisor, 'supervisor');
}

export function currentMessageDesk() {
  if (!state.user) return null;
  const key = state.user.role === 'student' ? 'student' : state.actingAs;
  return state.messageDesks[key] || null;
}

export function cachedTicketCopies(ticketId) {
  const copies = [];
  Object.keys(state.messageDesks).forEach(function(key) {
    (state.messageDesks[key].tickets || []).forEach(function(ticket) {
      if (ticket.ticketId === ticketId) copies.push({ key: key, ticket: ticket });
    });
  });
  return copies;
}
