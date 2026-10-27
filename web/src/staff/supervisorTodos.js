import { callServer, runMutation } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { escapeHtml, shortDate, textCompare } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { isStale } from '../shared/scene.js';
import { syncHeaderCohortSelect } from '../shared/staffContext.js';
import { state } from '../shared/state.js';
import { supervisorTodoStudentGroups, supervisorTodosByDueDate } from './supervisorTodoViews.js';

export function mayManageSupervisorTodos(user) {
  const permissions = (user && user.permissions) || {};
  return !!(permissions.isLead || permissions.canAdmin);
}

function dueKey(due) {
  return due ? String(due).slice(0, 10) : '9999-99-99';
}

function todayStamp() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return now.getFullYear() + '-' + month + '-' + day;
}

export function supervisorTodoEntries(home) {
  const milestones = (home.supervisorMilestoneTodos || []).map(function(item) {
    return {
      kind: 'milestone',
      studentEmail: item.studentEmail,
      studentName: item.studentName || item.studentEmail,
      title: item.title || '',
      due: item.due || '',
      next: !!item.next,
    };
  });
  const added = (home.supervisorTodos || []).filter(function(item) {
    return item.status !== 'Completed';
  }).map(function(item) {
    return {
      kind: 'added',
      todoId: item.todoId,
      title: item.title || '',
      note: item.note || '',
      due: item.due || '',
      status: item.status || 'Pending',
    };
  });
  return milestones.concat(added).sort(function(left, right) {
    const rank = function(entry) { return entry.kind === 'added' ? 0 : (entry.next ? 1 : 2); };
    const primary = rank(left) - rank(right);
    if (primary) return primary;
    const due = dueKey(left.due).localeCompare(dueKey(right.due));
    if (due) return due;
    return textCompare(left.studentName || left.title, right.studentName || right.title);
  });
}

function completedEntries(added) {
  return (added || []).filter(function(item) { return item.status === 'Completed'; }).map(function(item) {
    return {
      kind: 'added',
      todoId: item.todoId,
      title: item.title || '',
      note: item.note || '',
      due: item.due || '',
      status: 'Completed',
    };
  });
}

export function supervisorTodoView() {
  return state.supervisorTodoView === 'student' ? 'student' : 'due';
}

export function rememberSupervisorTodoView(view) {
  state.supervisorTodoView = view === 'student' ? 'student' : 'due';
  try { window.localStorage.setItem('ee-hub-supervisor-todo-view', state.supervisorTodoView); }
  catch (error) { /* the choice still applies for this visit */ }
}

function todoEntryHtml(entry, mode, options) {
  const grouped = !!(options && options.grouped);
  if (entry.kind === 'milestone') {
    const when = entry.due ? shortDate(entry.due) : '';
    const overdue = !!(entry.due && entry.due < todayStamp());
    const detail = (grouped ? [when, overdue ? 'Overdue' : ''] : [entry.title, when, overdue ? 'Overdue' : '']).filter(Boolean).join(' · ');
    const flag = entry.next ? '<span class="todo-flag">Next</span>' : '';
    const heading = grouped ? (entry.title || 'Milestone') : entry.studentName;
    return `<li><button type="button" class="todo-open${entry.next ? ' is-next' : ''}${overdue ? ' is-overdue' : ''}" data-open-student="${escapeHtml(entry.studentEmail)}"><strong>${escapeHtml(heading)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}${flag}</button></li>`;
  }
  const when = entry.due ? shortDate(entry.due) : '';
  const bits = [entry.note, when].filter(Boolean).join(' · ');
  const done = entry.status === 'Completed';
  const action = done
    ? `<button type="button" class="link-button" data-reopen-supervisor-todo="${escapeHtml(entry.todoId)}">Reopen</button>`
    : `<button type="button" class="link-button" data-complete-supervisor-todo="${escapeHtml(entry.todoId)}" aria-label="${escapeHtml('Mark done: ' + entry.title)}">Done</button>`;
  const remove = mode === 'desk'
    ? `<button type="button" class="link-button" data-remove-supervisor-todo="${escapeHtml(entry.todoId)}" aria-label="${escapeHtml('Remove ' + entry.title)}">Remove</button>`
    : '';
  return `<li class="added${done ? ' done' : ''}"><div><strong>${escapeHtml(entry.title)}</strong>${bits ? `<span>${escapeHtml(bits)}</span>` : ''}</div><div class="todo-actions">${action}${remove}</div></li>`;
}

function supervisorTodoViewToggle(view) {
  const grouped = view === 'student';
  return `<div class="view-toggle" role="group" aria-label="Supervisor to-do view"><button type="button" data-supervisor-todo-view="due" aria-pressed="${grouped ? 'false' : 'true'}">By due date</button><button type="button" data-supervisor-todo-view="student" aria-pressed="${grouped ? 'true' : 'false'}">Group by student</button></div>`;
}

function supervisorTodoItemsHtml(entries, options) {
  return entries.map(function(entry) { return todoEntryHtml(entry, 'sidebar', options); }).join('');
}

function supervisorTodoDueHtml(entries) {
  const items = entries.length
    ? supervisorTodoItemsHtml(supervisorTodosByDueDate(entries))
    : '<li class="muted">Nothing is waiting on you.</li>';
  return `<ul>${items}</ul>`;
}

function supervisorTodoGroupsHtml(entries) {
  const groups = supervisorTodoStudentGroups(entries);
  if (!groups.length) return '<ul><li class="muted">Nothing is waiting on you.</li></ul>';
  return groups.map(function(group, index) {
    const id = 'supervisor-todo-group-' + index;
    const items = supervisorTodoItemsHtml(group.items, { grouped: group.kind === 'student' });
    return `<section class="todo-student" aria-labelledby="${id}"><h3 id="${id}">${escapeHtml(group.name)}</h3><ul>${items}</ul></section>`;
  }).join('');
}

export function supervisorTodoList(home) {
  if (!home || home.viewAs !== 'supervisor') return '';
  const entries = supervisorTodoEntries(home);
  const view = supervisorTodoView();
  const body = view === 'student' ? supervisorTodoGroupsHtml(entries) : supervisorTodoDueHtml(entries);
  return `<aside class="next-steps supervisor-todos" aria-labelledby="supervisor-todo-heading"><div class="todo-view"><h2 id="supervisor-todo-heading">Supervisor To Do</h2>${supervisorTodoViewToggle(view)}</div><p class="muted">Milestones you own, including each student's next milestone, and to-dos added for you.</p><div class="todo-scroll">${body}</div></aside>`;
}

function changeStatus(todoId, status, hooks) {
  runMutation('setSupervisorTodoStatus', [todoId, status], { key: 'supervisor-todo:' + todoId }).then(function(result) {
    if (!result || result.stale || result.rejected) return;
    hooks.reload();
  }).catch(showError);
}

export function bindSupervisorTodoActions(root, hooks) {
  root.querySelectorAll('[data-complete-supervisor-todo]').forEach(function(button) {
    button.addEventListener('click', function() {
      changeStatus(button.dataset.completeSupervisorTodo, 'Completed', hooks);
    });
  });
  root.querySelectorAll('[data-reopen-supervisor-todo]').forEach(function(button) {
    button.addEventListener('click', function() {
      changeStatus(button.dataset.reopenSupervisorTodo, 'Pending', hooks);
    });
  });
  root.querySelectorAll('[data-remove-supervisor-todo]').forEach(function(button) {
    button.addEventListener('click', function() {
      const title = button.getAttribute('aria-label') || 'this to-do';
      if (!window.confirm('Remove ' + title.replace(/^Remove /, '') + '?')) return;
      runMutation('deleteSupervisorTodo', [button.dataset.removeSupervisorTodo], { key: 'supervisor-todo:' + button.dataset.removeSupervisorTodo }).then(function(result) {
        if (!result || result.stale || result.rejected) return;
        hooks.reload();
      }).catch(showError);
    });
  });
  if (hooks.openStudent) {
    root.querySelectorAll('[data-open-student]').forEach(function(button) {
      button.addEventListener('click', function() { hooks.openStudent(button.dataset.openStudent); });
    });
  }
  root.querySelectorAll('.supervisor-card .add-todo').forEach(function(box) {
    const open = box.querySelector('.add-todo-open');
    const form = box.querySelector('.add-todo-form');
    if (!open || !form) return;
    open.addEventListener('click', function() {
      box.classList.add('is-open');
      open.setAttribute('aria-expanded', 'true');
      const input = form.querySelector('[data-todo-title]');
      if (input) input.focus();
    });
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      const title = form.querySelector('[data-todo-title]').value.trim();
      const note = form.querySelector('[data-todo-note]').value.trim();
      const due = form.querySelector('[data-todo-date]').value;
      if (!title) return;
      runMutation('addSupervisorTodo', [state.cohortId, box.dataset.supervisor, { title: title, note: note, due: due }], {
        key: 'supervisor-todo:new:' + box.dataset.supervisor,
      }).then(function(result) {
        if (!result || result.stale || result.rejected) return;
        hooks.reload();
      }).catch(showError);
    });
  });
}

function bindSupervisorTodoView(root, repaint) {
  root.querySelectorAll('[data-supervisor-todo-view]').forEach(function(button) {
    button.addEventListener('click', function() {
      const next = button.dataset.supervisorTodoView === 'student' ? 'student' : 'due';
      if (supervisorTodoView() === next) return;
      rememberSupervisorTodoView(next);
      if (repaint) repaint();
      const again = document.querySelector('[data-supervisor-todo-view="' + next + '"]');
      if (again) again.focus();
    });
  });
}

export function bindSupervisorTodoList(root, reload, repaint) {
  bindSupervisorTodoActions(root, { reload: reload });
  bindSupervisorTodoView(root, repaint || reload);
}

function supervisorCard(supervisor) {
  const open = supervisorTodoEntries({
    supervisorMilestoneTodos: supervisor.milestones,
    supervisorTodos: supervisor.added,
  });
  const rows = open.concat(completedEntries(supervisor.added));
  const list = rows.length
    ? rows.map(function(entry) { return todoEntryHtml(entry, 'desk'); }).join('')
    : '<li class="muted">Nothing is waiting.</li>';
  return `<article class="supervisor-card"><header><h2>${escapeHtml(supervisor.name)}</h2><p class="muted">${escapeHtml(supervisor.supervisorId)}</p></header><ul class="supervisor-todo-items">${list}</ul><div class="add-todo" data-supervisor="${escapeHtml(supervisor.supervisorId)}"><button type="button" class="add-todo-open" aria-expanded="false">+ Add to-do</button><form class="add-todo-form stack"><input data-todo-title maxlength="240" placeholder="To-do" aria-label="${escapeHtml('To-do for ' + supervisor.name)}" required><input data-todo-note maxlength="2000" placeholder="Note (optional)" aria-label="Note"><input data-todo-date type="date" aria-label="Due date"><button class="button" type="submit">Add</button></form></div></article>`;
}

function paintSupervisorDesk(main, desk, hooks) {
  const options = (desk.cohorts || []).map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === desk.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
  }).join('');
  const cards = (desk.supervisors || []).length
    ? desk.supervisors.map(supervisorCard).join('')
    : '<div class="empty">No supervisors are assigned in this cohort.</div>';
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">My Students</p><h1>Supervisor To Do</h1><p class="lede">Milestones each supervisor owns, including next milestones, and to-dos you add for them.</p></div><div class="page-actions"><button type="button" class="button secondary" id="supervisor-desk-back">Back to students</button></div></div>
    <div class="toolbar"><label for="supervisor-todo-cohort">Cohort</label><select id="supervisor-todo-cohort" aria-label="Cohort">${options}</select></div>
    <div class="supervisor-todo-list">${cards}</div>`;
  document.getElementById('supervisor-desk-back').addEventListener('click', hooks.back);
  const cohort = document.getElementById('supervisor-todo-cohort');
  if (cohort) cohort.addEventListener('change', function(event) {
    state.cohortId = event.target.value;
    syncHeaderCohortSelect();
    state.staffHome = null;
    state.staffSupervisor = '';
    hooks.reload();
  });
  bindSupervisorTodoActions(main, hooks);
}

export function renderSupervisorDesk(main, hooks) {
  main.innerHTML = loadingLine('Loading supervisor to-dos...');
  const sceneCohort = state.cohortId || '';
  callServer('getSupervisorTodoDesk', sceneCohort).then(function(desk) {
    if (!main.isConnected) return;
    state.cohortId = desk.cohortId || state.cohortId;
    syncHeaderCohortSelect();
    paintSupervisorDesk(main, desk, hooks);
  }).catch(function(error) {
    if (isStale(error)) return;
    showError(error);
    if (!main.isConnected) return;
    const message = error && error.message ? error.message : 'Supervisor to-dos could not be loaded.';
    main.innerHTML = `<div class="page-head"><div><p class="eyebrow">My Students</p><h1>Supervisor To Do</h1></div><div class="page-actions"><button type="button" class="button secondary" id="supervisor-desk-back">Back to students</button></div></div><p class="notice error">${escapeHtml(message)}</p>`;
    const back = document.getElementById('supervisor-desk-back');
    if (back) back.addEventListener('click', hooks.back);
  });
}
