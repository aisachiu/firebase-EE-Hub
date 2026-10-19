import { callServer, dispatchServer, enqueueTicket, markSync, quietServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene, isStale, sameScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { mergeTicketList, saveTicketShare, shareControl } from '../shared/tickets.js';
import { paintStaffAsStudent } from './students.js';
import { nextIncomplete } from '../student/home.js';
import { paintStudentJourney } from '../student/journey.js';

export function noteAuthorLabel(message, note) {
  if (message.authorName) return message.authorName;
  if (message.authorEmail && state.user && message.authorEmail === state.user.email) return state.user.displayName || 'You';
  if (message.authorRole === 'student') return (note && note.displayName) || 'Student';
  return message.authorEmail || 'Staff';
}

export function noteEntryHtml(message, note) {
  const when = String(message.createdAt || '').replace('T', ' ').slice(0, 16);
  return `<div class="note-entry" data-message="${escapeHtml(message.messageId)}"><p class="note-meta"><strong>${escapeHtml(noteAuthorLabel(message, note))}</strong>${when ? ' · ' + escapeHtml(when) : ''}</p><p>${escapeHtml(message.body || '')}</p></div>`;
}

export function noteMessagesHtml(note) {
  const messages = note.messages && note.messages.length ? note.messages : [{ messageId: '', body: '', authorName: note.authorName || '' }];
  return messages.map(function(message) { return noteEntryHtml(message, note); }).join('');
}

export function noteSortKey(note) {
  return String((note && (note.activityAt || note.lastUpdated || note.createdAt)) || '');
}

export function notesNewestFirst(notes) {
  return (notes || []).slice().sort(function(left, right) {
    return noteSortKey(right).localeCompare(noteSortKey(left));
  });
}

export function noteIsPending(note) {
  return String(note && note.ticketId || '').indexOf('pending-') === 0;
}

export function syncNoteListDom(notes) {
  const list = document.querySelector('#main .note-list');
  if (!list || state.notesPane === 'templates') return;
  const wanted = {};
  notes.forEach(function(note) { wanted[note.ticketId] = true; });
  Array.prototype.forEach.call(list.querySelectorAll('.note-card[data-ticket]'), function(card) {
    if (!wanted[card.dataset.ticket]) card.remove();
  });
  const empty = list.querySelector('.empty');
  if (notes.length && empty) empty.remove();
  notesNewestFirst(notes).forEach(function(note) {
    const id = String(note.ticketId).replace(/"/g, '');
    let card = list.querySelector('.note-card[data-ticket="' + id + '"]');
    if (!card) {
      list.insertAdjacentHTML('beforeend', renderNoteCard(note));
      card = list.querySelector('.note-card[data-ticket="' + id + '"]');
      if (card) bindNoteCard(card, note);
      return;
    }
    const thread = card.querySelector('.note-thread');
    if (thread) {
      const current = Array.prototype.map.call(thread.querySelectorAll('[data-message]'), function(node) {
        return node.dataset.message;
      }).join('\n');
      const nextIds = (note.messages || []).map(function(message) { return message.messageId; }).join('\n');
      if (current !== nextIds) thread.innerHTML = noteMessagesHtml(note);
    }
    card.dataset.updated = note.lastUpdated || '';
    if (note.activityAt) card.dataset.activity = note.activityAt;
    else delete card.dataset.activity;
    const title = card.querySelector('[data-note-title]');
    if (title) title.textContent = note.title || 'Note';
    const author = card.querySelector('[data-note-author]');
    if (author) author.textContent = note.authorName || '';
    const who = card.querySelector('[data-note-who]');
    if (who) who.textContent = note.displayName ? ' · ' + note.displayName : '';
    const box = card.querySelector('[data-share]');
    if (box) box.checked = !!note.shared;
  });
  notesNewestFirst(notes).forEach(function(note) {
    const id = String(note.ticketId).replace(/"/g, '');
    const card = list.querySelector('.note-card[data-ticket="' + id + '"]');
    if (card) list.appendChild(card);
  });
  if (!notes.length) list.innerHTML = '<div class="empty">Notes for your students appear here.</div>';
}

export function refreshStaffNotes(button) {
  if (!button || button.getAttribute('aria-busy') === 'true') return;
  const scene = state.scene;
  const actingAs = state.actingAs;
  markSync(button, 'pending');
  quietServer('getStaffNotesHub', [actingAs]).then(function(hub) {
    if (!sameScene(scene) || state.section !== 'notes' || state.actingAs !== actingAs) return;
    const local = state.notesHub;
    const merged = mergeTicketList((local && local.notes) || [], hub.notes || []);
    const next = local || hub;
    next.notes = merged;
    next.viewAs = hub.viewAs || next.viewAs;
    if (hub.templates) next.templates = hub.templates;
    if (hub.phases) next.phases = hub.phases;
    if (hub.students) next.students = hub.students;
    state.notesHub = next;
    if (state.notesPane !== 'templates') syncNoteListDom(next.notes);
    if (button.isConnected) markSync(button, 'confirmed');
  }).catch(function(error) {
    if (!sameScene(scene) || !button.isConnected) return;
    markSync(button, 'rejected');
    showError(error);
  });
}

export function setNotesOpen(open) {
  state.notesOpen = !!open;
  document.body.classList.toggle('notes-open', state.notesOpen);
  const panel = document.getElementById('notes-panel');
  if (panel) panel.classList.toggle('open', state.notesOpen);
  const toggle = document.getElementById('notes-toggle');
  const peek = document.getElementById('notes-peek');
  if (toggle) toggle.setAttribute('aria-expanded', state.notesOpen ? 'true' : 'false');
  if (peek) peek.setAttribute('aria-expanded', state.notesOpen ? 'true' : 'false');
  const drawer = document.getElementById('notes-drawer');
  if (drawer) {
    drawer.setAttribute('aria-hidden', state.notesOpen ? 'false' : 'true');
    if (state.notesOpen) drawer.removeAttribute('inert');
    else drawer.setAttribute('inert', '');
  }
}

export function mountNotesPanel() {
  const body = document.getElementById('notes-body');
  const home = state.staffStudentHome;
  if (!body || !home) return;
  body.innerHTML = loadingLine('Loading notes...');
  callServer('getStaffStudentPanel', home.email, home.cohort || state.cohortId, state.actingAs).then(function(panel) {
    const target = document.getElementById('notes-body');
    if (!target) return;
    paintStudentNotes(target, panel, home);
  }).catch(function(error) {
    if (isStale(error)) return;
    const target = document.getElementById('notes-body');
    if (target) target.innerHTML = '<p class="notice error">' + escapeHtml(error && error.message ? error.message : error) + '</p>';
  });
}

export function noteBody(note) {
  const message = (note.messages || [])[0];
  return message && message.body ? message.body : (note.title || '');
}

export function phaseLabel(phaseId, phases) {
  if (!phaseId) return 'Current phase';
  const match = (phases || []).filter(function(phase) { return phase.phaseId === phaseId; })[0];
  return match ? (match.phaseTitle || phaseId) : phaseId;
}

export function currentStudentPhaseId() {
  const home = state.staffStudentHome;
  if (!home) return '';
  const next = nextIncomplete(home);
  return next && next.template ? next.template.phase : '';
}

export function paintStudentNotes(target, panel, home) {
  const notes = panel.notes || [];
  const templates = panel.templates || [];
  const canWrite = !!panel.canWrite;
  const ordered = notesNewestFirst(notes);
  target.innerHTML = `${canWrite ? '<div class="add-todo" id="student-note-composer"><button type="button" class="add-todo-open" aria-expanded="false">+ Add note</button><form class="add-todo-form stack"><input maxlength="90" placeholder="Title" aria-label="Note title" required><textarea maxlength="2000" placeholder="Note" aria-label="New note" required></textarea><button class="button" type="submit">Save</button></form></div>' : ''}
    <div class="note-list">${ordered.length ? ordered.map(renderNoteCard).join('') : '<div class="empty">No notes for this student yet.</div>'}</div>
    <h2>Template tasks</h2>
    <div class="note-list">${templates.length ? templates.map(function(template) {
      return `<article class="note-card"><div class="template-row"><div><strong>${escapeHtml(template.title)}</strong><p class="muted">${escapeHtml(template.description || phaseLabel(template.phaseId, panel.phases))}</p></div>${canWrite ? `<button type="button" class="button" data-apply-template="${escapeHtml(template.templateId)}">Add</button>` : ''}</div></article>`;
    }).join('') : '<div class="empty">Save template tasks from the Notes tab.</div>'}</div>`;
  bindStackedNoteComposer(target.querySelector('#student-note-composer'), function(title, text) {
    return callServer('createStaffNote', home.email, home.cohort || state.cohortId, title, text, state.actingAs).then(function() {
      showSuccess('Note saved.');
      mountNotesPanel();
    });
  });
  bindNoteList(target.querySelector('.note-list'), ordered);
  target.querySelectorAll('[data-apply-template]').forEach(function(button) {
    button.addEventListener('click', function() {
      button.disabled = true;
      const template = templates.filter(function(item) { return item.templateId === button.dataset.applyTemplate; })[0];
      const phaseId = (template && template.phaseId) || currentStudentPhaseId();
      callServer('applyTodoTemplate', button.dataset.applyTemplate, home.email, home.cohort || state.cohortId, phaseId, state.actingAs).then(function() {
        return callServer('getStaffStudentHome', home.email, home.cohort || state.cohortId, state.actingAs);
      }).then(function(fresh) {
        state.staffStudentHome = fresh;
        paintStudentJourney(fresh);
        if (state.section === 'students') paintStaffAsStudent(fresh);
        showSuccess('Template task added to the journey.');
        mountNotesPanel();
      }).catch(function(error) {
        button.disabled = false;
        showError(error);
      });
    });
  });
}

export function renderNoteCard(note) {
  const pending = noteIsPending(note);
  const student = note.displayName ? ' · ' + escapeHtml(note.displayName) : '';
  return `<article class="note-card" data-ticket="${escapeHtml(note.ticketId)}" data-updated="${escapeHtml(note.lastUpdated || '')}"${note.activityAt ? ` data-activity="${escapeHtml(note.activityAt)}"` : ''}><header class="note-head"><strong data-note-title>${escapeHtml(note.title || 'Note')}</strong><p class="note-meta"><span data-note-author>${escapeHtml(note.authorName || '')}</span><span data-note-who>${student}</span></p></header><div class="note-thread">${noteMessagesHtml(note)}</div><form class="note-reply" data-note-reply><textarea maxlength="2000" placeholder="Write a reply" aria-label="Reply"${pending ? ' disabled' : ''}></textarea><button class="button" type="submit"${pending ? ' disabled' : ''}>Reply</button></form><div class="template-row">${shareControl(note)}</div></article>`;
}

export function reorderNoteCards(list) {
  if (!list) return;
  const cards = Array.prototype.slice.call(list.querySelectorAll(':scope > .note-card[data-ticket]'));
  cards.sort(function(left, right) {
    const leftKey = left.dataset.activity || left.dataset.updated || '';
    const rightKey = right.dataset.activity || right.dataset.updated || '';
    return String(rightKey).localeCompare(String(leftKey));
  });
  cards.forEach(function(item) { list.appendChild(item); });
}

export function moveNoteToFront(note, card) {
  if (state.notesHub && state.notesHub.notes) {
    const notes = state.notesHub.notes;
    const index = notes.indexOf(note);
    if (index > 0) {
      notes.splice(index, 1);
      notes.unshift(note);
    }
  }
  const list = card && card.parentElement;
  if (list && list.firstElementChild !== card) list.insertBefore(card, list.firstElementChild);
}

export function sendNoteReply(note, card, body) {
  const message = {
    messageId: 'pending-' + Date.now(),
    authorRole: 'staff',
    authorEmail: state.user.email,
    authorName: state.user.displayName || state.user.email,
    body: body,
    createdAt: new Date().toISOString()
  };
  note.messages = (note.messages || []).concat([message]);
  note.activityAt = message.createdAt;
  const thread = card.querySelector('.note-thread');
  if (thread) thread.insertAdjacentHTML('beforeend', noteEntryHtml(message, note));
  const field = card.querySelector('[data-note-reply] textarea');
  const submit = card.querySelector('[data-note-reply] button');
  if (field) field.value = '';
  if (submit) submit.disabled = true;
  card.dataset.activity = message.createdAt;
  moveNoteToFront(note, card);
  markSync(card, 'pending');
  const viewAs = state.actingAs;
  enqueueTicket(note.ticketId, function() {
    return dispatchServer('replyTicket', [note.ticketId, body, note.lastUpdated, viewAs]);
  }).then(function(result) {
    note.lastUpdated = result.lastUpdated || note.lastUpdated;
    note.activityAt = note.lastUpdated;
    card.dataset.updated = note.lastUpdated || '';
    card.dataset.activity = note.lastUpdated || '';
    if (submit) submit.disabled = noteIsPending(note);
    markSync(card, 'confirmed');
  }).catch(function(error) {
    note.messages = (note.messages || []).filter(function(item) { return item.messageId !== message.messageId; });
    delete note.activityAt;
    const entry = card.querySelector('[data-message="' + message.messageId + '"]');
    if (entry) entry.remove();
    if (field && !field.value) field.value = body;
    delete card.dataset.activity;
    if (submit) submit.disabled = noteIsPending(note);
    reorderNoteCards(card.parentElement);
    markSync(card, 'rejected');
    showError(error);
  });
}

export function bindNoteReply(card, note) {
  if (!card || card.dataset.replyBound === 'true') return;
  const form = card.querySelector('[data-note-reply]');
  if (!form) return;
  card.dataset.replyBound = 'true';
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    if (noteIsPending(note)) return;
    const field = form.querySelector('textarea');
    const body = field ? field.value.trim() : '';
    if (!body) return;
    if (body.length > 2000) {
      showError(new Error('Replies must be 2,000 characters or fewer.'));
      return;
    }
    sendNoteReply(note, card, body);
  });
}

export function bindNoteCard(card, note) {
  bindShareList(card, [note]);
  bindNoteReply(card, note);
}

export function bindNoteList(list, notes) {
  if (!list) return;
  const byId = {};
  (notes || []).forEach(function(note) { byId[note.ticketId] = note; });
  list.querySelectorAll('.note-card[data-ticket]').forEach(function(card) {
    const note = byId[card.dataset.ticket];
    if (note) bindNoteCard(card, note);
  });
}

export function bindStackedNoteComposer(box, onSave) {
  if (!box) return;
  const open = box.querySelector('.add-todo-open');
  const form = box.querySelector('.add-todo-form');
  const titleInput = form.querySelector('input');
  const textArea = form.querySelector('textarea');
  open.addEventListener('click', function() {
    box.classList.add('is-open');
    open.setAttribute('aria-expanded', 'true');
    titleInput.focus();
  });
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    const title = titleInput.value.trim();
    const text = textArea.value.trim();
    if (!title) {
      showError(new Error('Add a title.'));
      return;
    }
    if (title.length > 90) {
      showError(new Error('Titles must be 90 characters or fewer.'));
      return;
    }
    if (!text) {
      showError(new Error('Write a note before saving.'));
      return;
    }
    if (text.length > 2000) {
      showError(new Error('Notes must be 2,000 characters or fewer.'));
      return;
    }
    const submit = form.querySelector('button');
    submit.disabled = true;
    Promise.resolve(onSave(title, text, box)).then(function() {
      titleInput.value = '';
      textArea.value = '';
      submit.disabled = false;
    }).catch(function(error) {
      submit.disabled = false;
      showError(error);
    });
  });
}

export function bindNoteComposer(box, onSave) {
  if (!box) return;
  const open = box.querySelector('.add-todo-open');
  const form = box.querySelector('.add-todo-form');
  const input = form.querySelector('input');
  open.addEventListener('click', function() {
    box.classList.add('is-open');
    open.setAttribute('aria-expanded', 'true');
    input.focus();
  });
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const submit = form.querySelector('button');
    submit.disabled = true;
    onSave(text, box).catch(function(error) {
      submit.disabled = false;
      showError(error);
    });
  });
}

export function bindShareList(root, notes, after) {
  const byId = {};
  (notes || []).forEach(function(note) { byId[note.ticketId] = note; });
  root.querySelectorAll('[data-share]').forEach(function(box) {
    const label = box.closest('label');
    if (label) label.addEventListener('click', function(event) { event.stopPropagation(); });
    box.addEventListener('click', function(event) { event.stopPropagation(); });
    box.addEventListener('change', function() {
      const note = byId[box.dataset.share];
      if (!note) return;
      saveTicketShare(note, box.checked);
    });
  });
}

export function renderStaffNotes() {
  advanceScene();
  const main = document.getElementById('main');
  main.innerHTML = loadingLine('Loading notes...');
  callServer('getStaffNotesHub', state.actingAs).then(function(hub) {
    state.notesHub = hub;
    paintStaffNotes(hub);
  }).catch(showError);
}

export function paintStaffNotes(hub) {
  const main = document.getElementById('main');
  const pane = state.notesPane === 'templates' ? 'templates' : 'notes';
  const notes = hub.notes || [];
  const templates = hub.templates || [];
  const phases = hub.phases || [];
  const students = hub.students || [];
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Supervisor</p><h1>Notes</h1><p class="lede">Staff notes are visible to every staff member who can open the student. Tick Visible for student when the student should see the thread.</p></div><div class="page-actions"><button type="button" class="button secondary" id="refresh-notes">Refresh</button></div></div>
    <nav class="subnav" aria-label="Notes sections">
      <button type="button" data-notes-pane="notes" aria-current="${pane === 'notes' ? 'page' : 'false'}">Notes</button>
      <button type="button" data-notes-pane="templates" aria-current="${pane === 'templates' ? 'page' : 'false'}">Template Tasks</button>
    </nav>
    ${pane === 'templates' ? renderTemplateTasks(templates, phases) : `${renderNoteComposer(students)}<div class="note-list">${notes.length ? notesNewestFirst(notes).map(renderNoteCard).join('') : `<div class="empty">${noteListEmpty(hub, students)}</div>`}</div>`}`;
  document.getElementById('refresh-notes').addEventListener('click', function(event) { refreshStaffNotes(event.currentTarget); });
  main.querySelectorAll('[data-notes-pane]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.notesPane = button.dataset.notesPane;
      paintStaffNotes(state.notesHub || hub);
    });
  });
  if (pane === 'notes') {
    bindStaffNoteComposer(main, students);
    bindNoteList(main.querySelector('.note-list'), notes);
  } else bindTemplateTasks(main, phases);
}

export function noteListEmpty(hub, students) {
  if (students.length) return 'Notes for your students appear here.';
  if (hub.viewAs === 'supervisor') return 'No students are assigned to you yet.';
  return 'Open a student to take a note. Notes for your students appear here.';
}

export function renderNoteComposer(students) {
  if (!students.length) return '';
  const cohorts = {};
  students.forEach(function(student) { cohorts[student.cohortId] = true; });
  const manyCohorts = Object.keys(cohorts).length > 1;
  const options = students.map(function(student) {
    const label = student.displayName + (student.subject ? ' · ' + student.subject : '') + (manyCohorts ? ' · ' + student.cohortId : '');
    return `<option value="${escapeHtml(student.email)}" data-cohort="${escapeHtml(student.cohortId)}">${escapeHtml(label)}</option>`;
  }).join('');
  return `<div class="add-todo" id="note-composer"><button type="button" class="add-todo-open" aria-expanded="false">+ Add note</button><form class="add-todo-form stack"><select aria-label="Student" required><option value="">Choose a student</option>${options}</select><input maxlength="90" placeholder="Title" aria-label="Note title" required><textarea maxlength="2000" placeholder="Note" aria-label="Note" required></textarea><button class="button" type="submit">Save</button></form></div>`;
}

export function bindStaffNoteComposer(main, students) {
  const box = main.querySelector('#note-composer');
  if (!box) return;
  const open = box.querySelector('.add-todo-open');
  const form = box.querySelector('form');
  const select = form.querySelector('select');
  const titleInput = form.querySelector('input');
  const textArea = form.querySelector('textarea');
  open.addEventListener('click', function() {
    box.classList.add('is-open');
    open.setAttribute('aria-expanded', 'true');
    select.focus();
  });
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    const email = select.value;
    const option = select.options[select.selectedIndex];
    const cohortId = option ? option.getAttribute('data-cohort') || '' : '';
    const title = titleInput.value.trim();
    const text = textArea.value.trim();
    if (!email || !cohortId) {
      showError(new Error('Choose a student.'));
      return;
    }
    if (!title) {
      showError(new Error('Add a title.'));
      return;
    }
    if (title.length > 90) {
      showError(new Error('Titles must be 90 characters or fewer.'));
      return;
    }
    if (!text) {
      showError(new Error('Write a note before saving.'));
      return;
    }
    if (text.length > 2000) {
      showError(new Error('Notes must be 2,000 characters or fewer.'));
      return;
    }
    const student = students.filter(function(item) { return item.email === email && item.cohortId === cohortId; })[0];
    if (!student) return;
    const submit = form.querySelector('button');
    const list = main.querySelector('.note-list');
    if (!list) return;
    submit.disabled = true;
    const authorName = state.user.displayName || state.user.email;
    const note = {
      ticketId: 'pending-' + Date.now(),
      title: title,
      authorName: authorName,
      displayName: student.displayName,
      category: 'Note',
      shared: false,
      canShare: true,
      kind: 'note',
      studentUnread: false,
      staffUnread: false,
      messages: [{
        messageId: 'pending-body-' + Date.now(),
        authorRole: 'staff',
        authorEmail: state.user.email,
        authorName: authorName,
        body: text,
        createdAt: new Date().toISOString()
      }],
      lastUpdated: '',
      activityAt: new Date().toISOString()
    };
    const hub = state.notesHub;
    if (hub) hub.notes = [note].concat(hub.notes || []);
    const empty = list.querySelector('.empty');
    if (empty) empty.remove();
    list.insertAdjacentHTML('afterbegin', renderNoteCard(note));
    const card = list.querySelector('.note-card');
    const share = card ? card.querySelector('[data-share]') : null;
    if (share) share.disabled = true;
    if (card) {
      bindNoteReply(card, note);
      markSync(card, 'pending');
    }
    titleInput.value = '';
    textArea.value = '';
    select.value = '';
    box.classList.remove('is-open');
    open.setAttribute('aria-expanded', 'false');
    const scene = state.scene;
    const actingAs = state.actingAs;
    dispatchServer('createStaffNote', [student.email, student.cohortId, title, text, actingAs]).then(function(result) {
      note.ticketId = result.ticketId;
      note.lastUpdated = result.lastUpdated || '';
      note.activityAt = note.lastUpdated;
      submit.disabled = false;
      if (!sameScene(scene) || state.section !== 'notes' || !card || !card.isConnected) return;
      card.dataset.ticket = note.ticketId;
      card.dataset.updated = note.lastUpdated;
      card.dataset.activity = note.lastUpdated;
      if (share) {
        share.dataset.share = note.ticketId;
        share.disabled = false;
      }
      const replyField = card.querySelector('[data-note-reply] textarea');
      const replyButton = card.querySelector('[data-note-reply] button');
      if (replyField) replyField.disabled = false;
      if (replyButton) replyButton.disabled = false;
      bindShareList(card, [note]);
      markSync(card, 'confirmed');
    }).catch(function(error) {
      if (hub && hub.notes) hub.notes = hub.notes.filter(function(item) { return item !== note; });
      if (card && card.isConnected) card.remove();
      if (list.isConnected && !list.querySelector('.note-card')) list.innerHTML = '<div class="empty">Notes for your students appear here.</div>';
      submit.disabled = false;
      if (!titleInput.value) titleInput.value = title;
      if (!textArea.value) textArea.value = text;
      if (!select.value) select.value = email;
      box.classList.add('is-open');
      open.setAttribute('aria-expanded', 'true');
      showError(error);
    });
  });
}

export function renderTemplateTasks(templates, phases) {
  const options = phases.map(function(phase) {
    return `<option value="${escapeHtml(phase.phaseId)}">${escapeHtml(phase.phaseTitle || phase.phaseId)}</option>`;
  }).join('');
  return `<div class="add-todo" id="template-composer"><button type="button" class="add-todo-open" aria-expanded="false">+ Add template</button><form class="add-todo-form stack"><input maxlength="240" placeholder="Template task" aria-label="Template title" required><input maxlength="2000" placeholder="Note for the student (optional)" aria-label="Template note"><select aria-label="Phase"><option value="">Current phase when added</option>${options}</select><button class="button" type="submit">Save</button></form></div>
    <div class="note-list">${templates.length ? templates.map(function(template) {
      return `<article class="note-card"><div class="template-row"><div><strong>${escapeHtml(template.title)}</strong>${template.description ? `<p class="muted">${escapeHtml(template.description)}</p>` : ''}<div class="muted">${escapeHtml(phaseLabel(template.phaseId, phases))}</div></div><button type="button" class="link-button" data-remove-template="${escapeHtml(template.templateId)}">Remove</button></div></article>`;
    }).join('') : '<div class="empty">No template tasks yet.</div>'}</div>`;
}

export function bindTemplateTasks(main, phases) {
  bindNoteComposer(main.querySelector('#template-composer'), function(ignored, box) {
    const inputs = box.querySelectorAll('input');
    const title = inputs[0].value.trim();
    const description = inputs[1] ? inputs[1].value.trim() : '';
    const phaseId = box.querySelector('select') ? box.querySelector('select').value : '';
    if (!title) return Promise.resolve();
    return callServer('saveTodoTemplate', { title: title, description: description, phaseId: phaseId }).then(function() {
      showSuccess('Template task saved.');
      renderStaffNotes();
    });
  });
  main.querySelectorAll('[data-remove-template]').forEach(function(button) {
    button.addEventListener('click', function() {
      button.disabled = true;
      callServer('deleteTodoTemplate', button.dataset.removeTemplate).then(function() {
        showSuccess('Template task removed.');
        renderStaffNotes();
      }).catch(function(error) {
        button.disabled = false;
        showError(error);
      });
    });
  });
}
