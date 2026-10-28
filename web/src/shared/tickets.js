import { dispatchServer, enqueueTicket, markSync, quietServer } from './api.js';
import { cachedTicketCopies, currentMessageDesk, rememberMessageDesk } from './desk.js';
import { showError } from './feedback.js';
import { escapeHtml } from './html.js';
import { sameScene } from './scene.js';
import { state } from './state.js';
import { paintTabDot } from '../navigation.js';

export function routeNote(route) {
  return route === 'coordinator' ? 'This message goes to the EE Coordinator.' : 'This message goes to your supervisor.';
}

export function openFocusedTicket(main) {
  if (!state.focusTicket || !main) return;
  const id = state.focusTicket;
  state.focusTicket = '';
  const details = main.querySelector('details[data-ticket="' + id.replace(/"/g, '') + '"]');
  if (details) details.open = true;
}

export function syncStudentUnread(hub) {
  if (!hub) return;
  hub.unreadCount = (hub.tickets || []).filter(function(ticket) { return ticket.studentUnread; }).length;
  if (state.studentHome) {
    state.studentHome.unreadTicketCount = hub.unreadCount;
    state.studentHome.unreadTickets = (hub.tickets || []).filter(function(ticket) { return ticket.studentUnread; }).map(function(ticket) {
      return { ticketId: ticket.ticketId, title: ticket.title, category: ticket.category, lastUpdated: ticket.lastUpdated };
    });
  }
  paintTabDot('supervisor', hub.unreadCount, 'Supervisor');
}

export function syncStaffUnread(hub) {
  if (!hub) return;
  hub.unreadCount = (hub.tickets || []).filter(function(ticket) { return ticket.staffUnread; }).length;
  if (state.actingAs === hub.viewAs) {
    state.staffTicketUnread = hub.unreadCount;
    state.ticketBadgeFor = hub.viewAs;
    paintTabDot('tickets', hub.unreadCount, 'Messages');
  }
}

export function categoryChip(name, categories) {
  const match = (categories || []).filter(function(item) { return item.name === name; })[0];
  return `<span class="chip ${match ? match.chip : ''}">${escapeHtml(name)}</span>`;
}

export function messageLabel(message, ticket) {
  if (state.user.role === 'student') {
    if (message.authorRole === 'student') return 'You';
    return ticket.route === 'coordinator' ? 'EE Coordinator' : 'Supervisor';
  }
  if (message.authorEmail === state.user.email) return 'You';
  if (message.authorName) return message.authorName;
  if (message.authorRole === 'student') return ticket.displayName || 'Student';
  return 'Staff';
}

export function itemKindChip(ticket) {
  if (!ticket.shared) return '<span class="chip" data-kind-chip>Note</span>';
  if (ticket.category === 'Note') return '<span class="chip" data-kind-chip>Message</span>';
  return categoryChip(ticket.category, (state.ticketHub && state.ticketHub.categories) || []).replace('<span class="chip', '<span data-kind-chip class="chip');
}

export function shareControl(ticket) {
  const note = ticket.category === 'Note';
  const label = note ? 'Visible for student' : 'Shared';
  if (!ticket.canShare) {
    if (!note || !state.user || state.user.role !== 'staff') return '';
    return `<label class="share-check" title="Only the author can change this"><input type="checkbox" data-share="${escapeHtml(ticket.ticketId)}" ${ticket.shared ? 'checked' : ''} disabled aria-label="${escapeHtml(label)}"> ${escapeHtml(label)}</label>`;
  }
  return `<label class="share-check"><input type="checkbox" data-share="${escapeHtml(ticket.ticketId)}" ${ticket.shared ? 'checked' : ''} aria-label="${escapeHtml(label)}"> ${escapeHtml(label)}</label>`;
}

export function messageMarkup(message, ticket) {
  const mine = state.user.role === 'student' ? message.authorRole === 'student' : message.authorEmail === state.user.email;
  return `<article class="msg ${mine ? 'mine' : 'staff'}" data-message="${escapeHtml(message.messageId)}"><strong>${escapeHtml(messageLabel(message, ticket))}</strong> <span class="muted">${escapeHtml(String(message.createdAt || '').replace('T', ' ').slice(0, 16))}</span><p>${escapeHtml(message.body)}</p></article>`;
}

export function renderTicket(ticket, staff) {
  const unread = staff ? ticket.staffUnread : ticket.studentUnread;
  return `<details class="ticket" data-ticket="${escapeHtml(ticket.ticketId)}" data-updated="${escapeHtml(ticket.lastUpdated || '')}">
    <summary>${itemKindChip(ticket)}<strong>${escapeHtml(ticket.title)}</strong><span class="chip" data-status-chip>${escapeHtml(ticket.status)}</span><span class="muted">${escapeHtml(ticket.routeLabel || '')}</span>${staff ? `<span class="muted">${escapeHtml(ticket.displayName || '')}</span>` : ''}${shareControl(ticket)}${unread ? '<span class="dot" aria-label="Unread"></span>' : ''}</summary>
    <div class="body"><div class="thread">${(ticket.messages || []).map(function(message) { return messageMarkup(message, ticket); }).join('')}</div>
    ${staff ? `<label class="field">Status<select data-ticket-status>${['Open', 'In Progress', 'Resolved', 'Closed'].map(function(status) {
      return `<option ${ticket.status === status ? 'selected' : ''}>${status}</option>`;
    }).join('')}</select></label>` : ''}
    <label class="field">Reply<textarea data-ticket-reply maxlength="2000" placeholder="Write a reply"></textarea></label>
    <div><button type="button" class="button" data-send-ticket="${escapeHtml(ticket.ticketId)}">Send</button></div></div></details>`;
}

export function liveTicket(ticketId) {
  const safe = String(ticketId || '').replace(/"/g, '');
  if (!safe) return null;
  return document.querySelector('details.ticket[data-ticket="' + safe + '"]');
}

export function withCachedTickets(ticketId, visit) {
  const seen = [];
  cachedTicketCopies(ticketId).forEach(function(copy) {
    if (seen.indexOf(copy.ticket) >= 0) return;
    seen.push(copy.ticket);
    visit(copy.ticket);
  });
}

export function refreshTicketChrome(ticket) {
  const details = liveTicket(ticket.ticketId);
  if (!details) return;
  const kind = details.querySelector('[data-kind-chip]');
  if (kind) kind.outerHTML = itemKindChip(ticket);
  const status = details.querySelector('[data-status-chip]');
  if (status) status.textContent = ticket.status || '';
  const select = details.querySelector('[data-ticket-status]');
  if (select && ticket.status) select.value = ticket.status;
  const box = details.querySelector('[data-share]');
  if (box) {
    box.checked = !!ticket.shared;
    box.disabled = String(ticket.ticketId).indexOf('pending-') === 0;
  }
  details.dataset.updated = ticket.lastUpdated || '';
}

export function ticketStampNewer(left, right) {
  return String(left || '').localeCompare(String(right || '')) > 0;
}

export function sameOptimisticMessage(server, local) {
  if (!server || !local || server.body !== local.body) return false;
  if (local.authorEmail && server.authorEmail) return server.authorEmail === local.authorEmail;
  return server.authorRole === local.authorRole;
}

export function mergeIntoTicket(local, incoming) {
  if (ticketStampNewer(local.lastUpdated, incoming.lastUpdated)) return;
  ['status', 'shared', 'kind', 'lastUpdated', 'studentUnread', 'staffUnread', 'route', 'routeLabel', 'displayName', 'title', 'category', 'canShare', 'authorEmail', 'authorName', 'assignee'].forEach(function(key) {
    if (incoming[key] !== undefined) local[key] = incoming[key];
  });
  const incomingMessages = incoming.messages || [];
  const pending = (local.messages || []).filter(function(message) {
    if (String(message.messageId).indexOf('pending-') !== 0) return false;
    return !incomingMessages.some(function(item) { return sameOptimisticMessage(item, message); });
  });
  local.messages = incomingMessages.concat(pending);
}

export function mergeTicketList(localTickets, incomingTickets) {
  const byId = {};
  (localTickets || []).forEach(function(ticket) { byId[ticket.ticketId] = ticket; });
  const merged = [];
  (localTickets || []).forEach(function(ticket) {
    if (String(ticket.ticketId).indexOf('pending-') === 0) merged.push(ticket);
  });
  (incomingTickets || []).forEach(function(incoming) {
    const local = byId[incoming.ticketId];
    if (local) mergeIntoTicket(local, incoming);
    merged.push(local || incoming);
  });
  return merged;
}

export function refreshUnreadDot(details, ticket, staff) {
  if (!details) return;
  const unread = staff ? !!ticket.staffUnread : !!ticket.studentUnread;
  const dot = details.querySelector('summary .dot');
  if (unread && !dot) {
    const summary = details.querySelector('summary');
    if (summary) summary.insertAdjacentHTML('beforeend', '<span class="dot" aria-label="Unread"></span>');
  } else if (!unread && dot) dot.remove();
}

export function syncThread(details, ticket) {
  const thread = details.querySelector('.thread');
  if (!thread) return;
  const current = Array.prototype.map.call(thread.querySelectorAll('[data-message]'), function(node) {
    return node.dataset.message;
  }).join('\n');
  const next = (ticket.messages || []).map(function(message) { return message.messageId; }).join('\n');
  if (current === next) return;
  thread.innerHTML = (ticket.messages || []).map(function(message) {
    return messageMarkup(message, ticket);
  }).join('');
}

export function syncTicketListDom(tickets, staff) {
  const list = document.getElementById('ticket-list');
  if (!list) return;
  const wanted = {};
  tickets.forEach(function(ticket) { wanted[ticket.ticketId] = true; });
  Array.prototype.forEach.call(list.querySelectorAll('details.ticket'), function(details) {
    if (!wanted[details.dataset.ticket]) details.remove();
  });
  const empty = list.querySelector('.empty');
  if (tickets.length && empty) empty.remove();
  tickets.forEach(function(ticket) {
    const id = String(ticket.ticketId).replace(/"/g, '');
    let details = list.querySelector('details.ticket[data-ticket="' + id + '"]');
    if (!details) {
      list.insertAdjacentHTML('beforeend', renderTicket(ticket, staff));
      details = list.querySelector('details.ticket[data-ticket="' + id + '"]');
      if (details) bindOneTicket(details, ticket, staff);
      return;
    }
    syncThread(details, ticket);
    refreshTicketChrome(ticket);
    refreshUnreadDot(details, ticket, staff);
  });
  tickets.forEach(function(ticket) {
    const id = String(ticket.ticketId).replace(/"/g, '');
    const details = list.querySelector('details.ticket[data-ticket="' + id + '"]');
    if (details) list.appendChild(details);
  });
  if (!tickets.length) {
    list.innerHTML = '<div class="empty">' + (staff ? 'No messages in this queue.' : 'You have not sent a message yet.') + '</div>';
  }
}

export function updateMessageCount(tickets) {
  const count = document.getElementById('message-count');
  if (!count) return;
  const total = (tickets || []).length;
  count.textContent = total + ' message' + (total === 1 ? '' : 's');
}

export function refreshMessageDesk(button, staff) {
  if (!button || button.getAttribute('aria-busy') === 'true') return;
  const scene = state.scene;
  const section = state.section;
  const actingAs = state.actingAs;
  const key = staff ? actingAs : 'student';
  markSync(button, 'pending');
  const request = staff ? quietServer('getStaffTickets', [actingAs]) : quietServer('getTicketHub', []);
  request.then(function(hub) {
    if (!sameScene(scene) || state.section !== section || (staff && state.actingAs !== actingAs)) return;
    const local = state.messageDesks[key];
    const merged = local ? mergeTicketList(local.tickets || [], hub.tickets || []) : (hub.tickets || []);
    const next = local || hub;
    next.tickets = merged;
    if (hub.faqs) next.faqs = hub.faqs;
    if (hub.categories) next.categories = hub.categories;
    if (hub.viewAs) next.viewAs = hub.viewAs;
    if (!local) rememberMessageDesk(next, key);
    if (staff) syncStaffUnread(next);
    else syncStudentUnread(next);
    syncTicketListDom(next.tickets, staff);
    updateMessageCount(next.tickets);
    if (button.isConnected) markSync(button, 'confirmed');
  }).catch(function(error) {
    if (!sameScene(scene) || !button.isConnected) return;
    markSync(button, 'rejected');
    showError(error);
  });
}

export function rememberTicketRead(ticket, staff) {
  withCachedTickets(ticket.ticketId, function(copy) {
    if (staff) copy.staffUnread = false;
    else copy.studentUnread = false;
  });
  if (staff && state.staffHome && state.staffHome.unreadTickets) {
    state.staffHome.unreadTickets = state.staffHome.unreadTickets.filter(function(item) { return item.ticketId !== ticket.ticketId; });
    state.staffHome.unreadTicketCount = Math.max(0, (state.staffHome.unreadTicketCount || 0) - 1);
  }
  if (staff) syncStaffUnread(state.messageDesks[state.actingAs]);
  else syncStudentUnread(state.messageDesks.student);
}

export function markTicketOpened(ticket, details, staff) {
  const unread = staff ? ticket.staffUnread : ticket.studentUnread;
  if (!unread || String(ticket.ticketId).indexOf('pending-') === 0) return;
  const dot = details.querySelector('summary .dot');
  if (dot) dot.remove();
  rememberTicketRead(ticket, staff);
  const viewAs = staff ? state.actingAs : '';
  enqueueTicket(ticket.ticketId, function() {
    return dispatchServer('markTicketRead', [ticket.ticketId, ticket.lastUpdated, viewAs]);
  }).then(function(result) {
    if (!result || !result.lastUpdated) return;
    withCachedTickets(ticket.ticketId, function(copy) { copy.lastUpdated = result.lastUpdated; });
    const node = liveTicket(ticket.ticketId);
    if (node) node.dataset.updated = result.lastUpdated;
  }).catch(function(error) {
    withCachedTickets(ticket.ticketId, function(copy) {
      if (staff) copy.staffUnread = true;
      else copy.studentUnread = true;
    });
    if (staff) syncStaffUnread(state.messageDesks[state.actingAs]);
    else syncStudentUnread(state.messageDesks.student);
    const node = liveTicket(ticket.ticketId);
    if (node && !node.querySelector('summary .dot')) {
      const summary = node.querySelector('summary');
      if (summary) summary.insertAdjacentHTML('beforeend', '<span class="dot" aria-label="Unread"></span>');
    }
    showError(error);
  });
}

export function shareTargets(ticket) {
  const targets = [ticket];
  cachedTicketCopies(ticket.ticketId).forEach(function(copy) {
    if (targets.indexOf(copy.ticket) < 0) targets.push(copy.ticket);
  });
  if (state.notesHub && state.notesHub.notes) {
    state.notesHub.notes.forEach(function(note) {
      if (note.ticketId === ticket.ticketId && targets.indexOf(note) < 0) targets.push(note);
    });
  }
  return targets;
}

export function saveTicketShare(ticket, wanted) {
  const previous = !!ticket.shared;
  shareTargets(ticket).forEach(function(copy) {
    copy.shared = !!wanted;
    copy.kind = wanted ? 'message' : 'note';
  });
  refreshTicketChrome(ticket);
  const cards = document.querySelectorAll('[data-ticket="' + String(ticket.ticketId).replace(/"/g, '') + '"]');
  cards.forEach(function(node) {
    const kind = node.querySelector('[data-note-kind]');
    if (kind) kind.textContent = wanted ? 'Message' : 'Note';
    const box = node.querySelector('[data-share]');
    if (box) box.checked = !!wanted;
    markSync(node, 'pending');
  });
  const viewAs = state.user.role === 'staff' ? state.actingAs : '';
  enqueueTicket(ticket.ticketId, function() {
    return dispatchServer('setMessageShared', [ticket.ticketId, wanted, ticket.lastUpdated, viewAs]);
  }).then(function(result) {
    shareTargets(ticket).forEach(function(copy) {
      copy.shared = !!result.shared;
      copy.kind = result.kind || (copy.shared ? 'message' : 'note');
      copy.lastUpdated = result.lastUpdated || copy.lastUpdated;
    });
    if (!result.shared) {
      ['coordinator', 'supervisor'].forEach(function(key) {
        const hub = state.messageDesks[key];
        if (!hub || !hub.tickets) return;
        hub.tickets = hub.tickets.filter(function(item) { return item.ticketId !== ticket.ticketId; });
        syncStaffUnread(hub);
      });
    }
    document.querySelectorAll('[data-ticket="' + String(ticket.ticketId).replace(/"/g, '') + '"]').forEach(function(node) {
      const kind = node.querySelector('[data-note-kind]');
      if (kind) kind.textContent = result.shared ? 'Message' : 'Note';
      if (!result.shared && node.tagName === 'DETAILS' && state.section === 'tickets') {
        markSync(node, 'confirmed');
        window.setTimeout(function() { if (node.parentElement) node.remove(); }, 700);
        return;
      }
      markSync(node, 'confirmed');
    });
    const still = cachedTicketCopies(ticket.ticketId)[0];
    if (still) refreshTicketChrome(still.ticket);
    const count = document.getElementById('message-count');
    const desk = currentMessageDesk();
    if (count && desk) count.textContent = (desk.tickets || []).length + ' message' + ((desk.tickets || []).length === 1 ? '' : 's');
  }).catch(function(error) {
    shareTargets(ticket).forEach(function(copy) {
      copy.shared = previous;
      copy.kind = previous ? 'message' : 'note';
    });
    document.querySelectorAll('[data-ticket="' + String(ticket.ticketId).replace(/"/g, '') + '"]').forEach(function(node) {
      const kind = node.querySelector('[data-note-kind]');
      if (kind) kind.textContent = previous ? 'Message' : 'Note';
      const box = node.querySelector('[data-share]');
      if (box) box.checked = previous;
      markSync(node, 'rejected');
    });
    const still = cachedTicketCopies(ticket.ticketId)[0];
    if (still) refreshTicketChrome(still.ticket);
    showError(error);
  });
}

export function sendTicketUpdate(ticket, details, body, nextStatus, staff) {
  const previousStatus = ticket.status;
  const message = body ? {
    messageId: 'pending-' + Date.now(),
    authorRole: state.user.role === 'staff' ? 'staff' : 'student',
    authorEmail: state.user.email,
    body: body,
    createdAt: new Date().toISOString()
  } : null;
  let optimisticStatus = nextStatus || previousStatus;
  if (staff && body && (!nextStatus || nextStatus === previousStatus) && previousStatus === 'Open') optimisticStatus = 'In Progress';
  withCachedTickets(ticket.ticketId, function(copy) {
    copy.status = optimisticStatus;
    if (message) copy.messages = (copy.messages || []).concat([message]);
  });
  if (message) {
    const thread = details.querySelector('.thread');
    if (thread) thread.insertAdjacentHTML('beforeend', messageMarkup(message, ticket));
    const reply = details.querySelector('[data-ticket-reply]');
    if (reply) reply.value = '';
  }
  refreshTicketChrome(ticket);
  markSync(details, 'pending');
  const viewAs = staff ? state.actingAs : '';
  enqueueTicket(ticket.ticketId, function() {
    const token = ticket.lastUpdated;
    const started = body ? dispatchServer('replyTicket', [ticket.ticketId, body, token, viewAs]) : Promise.resolve({ lastUpdated: token, status: previousStatus });
    return started.then(function(result) {
      if (!nextStatus || nextStatus === result.status) return result;
      return dispatchServer('setTicketStatus', [ticket.ticketId, nextStatus, result.lastUpdated, viewAs]);
    });
  }).then(function(result) {
    withCachedTickets(ticket.ticketId, function(copy) {
      copy.lastUpdated = result.lastUpdated || copy.lastUpdated;
      if (result.status) copy.status = result.status;
    });
    const node = liveTicket(ticket.ticketId);
    if (!node || !node.isConnected) return;
    node.dataset.updated = result.lastUpdated || node.dataset.updated;
    refreshTicketChrome(ticket);
    markSync(node, 'confirmed');
  }).catch(function(error) {
    withCachedTickets(ticket.ticketId, function(copy) {
      copy.status = previousStatus;
      if (message) copy.messages = (copy.messages || []).filter(function(item) { return item.messageId !== message.messageId; });
    });
    const node = liveTicket(ticket.ticketId);
    if (node && node.isConnected) {
      if (message) {
        const article = node.querySelector('[data-message="' + message.messageId + '"]');
        if (article) article.remove();
        const reply = node.querySelector('[data-ticket-reply]');
        if (reply) reply.value = body;
      }
      refreshTicketChrome(ticket);
      markSync(node, 'rejected');
    }
    showError(error);
  });
}

export function bindOneTicket(details, ticket, staff) {
  details.addEventListener('toggle', function() {
    if (!details.open) return;
    markTicketOpened(ticket, details, staff);
  });
  details.querySelectorAll('[data-share]').forEach(function(box) {
    const label = box.closest('label');
    if (label) label.addEventListener('click', function(event) { event.stopPropagation(); });
    box.addEventListener('click', function(event) { event.stopPropagation(); });
    box.addEventListener('change', function() {
      saveTicketShare(ticket, box.checked);
    });
  });
  const button = details.querySelector('[data-send-ticket]');
  if (!button) return;
  button.addEventListener('click', function() {
    const body = details.querySelector('[data-ticket-reply]').value.trim();
    const statusSelect = details.querySelector('[data-ticket-status]');
    const status = statusSelect ? statusSelect.value : ticket.status;
    const statusChanged = !!(statusSelect && status !== ticket.status);
    if (!body && !statusChanged) return;
    if (body.length > 2000) {
      showError(new Error('Replies must be 2,000 characters or fewer.'));
      return;
    }
    sendTicketUpdate(ticket, details, body, statusChanged ? status : '', staff);
  });
}

export function bindTicketList(main, tickets, staff) {
  const byId = {};
  tickets.forEach(function(ticket) { byId[ticket.ticketId] = ticket; });
  main.querySelectorAll('details.ticket').forEach(function(details) {
    const ticket = byId[details.dataset.ticket];
    if (ticket) bindOneTicket(details, ticket, staff);
  });
}

export function openTicketDialog(categories) {
  const dialog = document.getElementById('form-dialog');
  let selected = categories[0] || null;
  dialog.hidden = false;
  dialog.innerHTML = `<div class="form-panel" role="dialog" aria-modal="true" aria-label="New message"><div class="toolbar"><h2>New message</h2><button type="button" class="button secondary" id="close-ticket">Close</button></div>
    <p class="muted">Choose who should see this.</p>
    <div class="cats" id="ticket-cats">${categories.map(function(category, index) {
      return `<button type="button" class="${category.chip}" data-category="${escapeHtml(category.name)}" aria-pressed="${index === 0 ? 'true' : 'false'}">${escapeHtml(category.name)}</button>`;
    }).join('')}</div>
    <p class="notice" id="ticket-route">${selected ? escapeHtml(routeNote(selected.route)) : ''}</p>
    <label class="field">Subject<input id="ticket-title" maxlength="90"></label>
    <label class="field">Message<textarea id="ticket-body" maxlength="2000"></textarea></label>
    <p class="notice error" id="ticket-error" hidden></p>
    <div class="toolbar"><button type="button" class="button" id="send-ticket">Send message</button></div></div>`;
  document.getElementById('close-ticket').addEventListener('click', function() { dialog.hidden = true; dialog.innerHTML = ''; });
  dialog.querySelectorAll('[data-category]').forEach(function(button) {
    button.addEventListener('click', function() {
      selected = categories.filter(function(category) { return category.name === button.dataset.category; })[0] || selected;
      dialog.querySelectorAll('[data-category]').forEach(function(item) { item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
      document.getElementById('ticket-route').textContent = selected ? routeNote(selected.route) : '';
    });
  });
  document.getElementById('send-ticket').addEventListener('click', function() {
    const error = document.getElementById('ticket-error');
    const title = document.getElementById('ticket-title').value.trim();
    const body = document.getElementById('ticket-body').value.trim();
    error.hidden = true;
    if (!selected) { error.hidden = false; error.textContent = 'Choose a category.'; return; }
    if (!title) { error.hidden = false; error.textContent = 'Add a short subject.'; return; }
    if (title.length > 90) { error.hidden = false; error.textContent = 'Subject must be 90 characters or fewer.'; return; }
    if (!body) { error.hidden = false; error.textContent = 'Write your message before sending.'; return; }
    if (body.length > 2000) { error.hidden = false; error.textContent = 'Messages must be 2,000 characters or fewer.'; return; }
    const hub = state.messageDesks.student || { tickets: [], categories: categories, faqs: [], unreadCount: 0 };
    if (!state.messageDesks.student) rememberMessageDesk(hub, 'student');
    const ticket = {
      ticketId: 'pending-' + Date.now(),
      title: title,
      category: selected.name,
      status: 'Open',
      route: selected.route,
      routeLabel: selected.route === 'coordinator' ? 'EE Coordinator' : 'Supervisor',
      shared: true,
      canShare: true,
      kind: 'message',
      studentUnread: false,
      staffUnread: true,
      messages: [{
        messageId: 'pending-body-' + Date.now(),
        authorRole: 'student',
        authorEmail: state.user.email,
        body: body,
        createdAt: new Date().toISOString()
      }],
      lastUpdated: ''
    };
    hub.tickets = [ticket].concat(hub.tickets || []);
    dialog.hidden = true;
    dialog.innerHTML = '';
    const list = document.getElementById('ticket-list');
    if (list) {
      const empty = list.querySelector('.empty');
      if (empty) empty.remove();
      list.insertAdjacentHTML('afterbegin', renderTicket(ticket, false));
      const details = liveTicket(ticket.ticketId);
      if (details) {
        details.open = true;
        const send = details.querySelector('[data-send-ticket]');
        if (send) send.disabled = true;
        markSync(details, 'pending');
        bindOneTicket(details, ticket, false);
      }
    }
    dispatchServer('createTicket', [{ category: selected.name, title: title, body: body }]).then(function(result) {
      const previousId = ticket.ticketId;
      ticket.ticketId = result.ticketId;
      ticket.route = result.route || ticket.route;
      ticket.routeLabel = result.routeLabel || ticket.routeLabel;
      ticket.lastUpdated = result.lastUpdated || '';
      const node = liveTicket(previousId);
      if (node) {
        node.dataset.ticket = ticket.ticketId;
        node.dataset.updated = ticket.lastUpdated;
        const box = node.querySelector('[data-share]');
        if (box) {
          box.dataset.share = ticket.ticketId;
          box.disabled = false;
        }
        const send = node.querySelector('[data-send-ticket]');
        if (send) {
          send.dataset.sendTicket = ticket.ticketId;
          send.disabled = false;
        }
        markSync(node, 'confirmed');
      }
    }).catch(function(failure) {
      hub.tickets = (hub.tickets || []).filter(function(item) { return item !== ticket; });
      const node = liveTicket(ticket.ticketId);
      if (node) node.remove();
      if (!hub.tickets.length) {
        const host = document.getElementById('ticket-list');
        if (host && !host.querySelector('.ticket')) host.innerHTML = '<div class="empty">You have not sent a message yet.</div>';
      }
      showError(failure);
    });
  });
}
